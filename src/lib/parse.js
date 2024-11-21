import ts from "typescript";
import {isJSDocAbstractTag, isJSDocTypeParamTag, isStaticModifier} from "./filter";

/**
 * Traverse to a given namespace in a map, then take some kind of action
 * @param {String|ts.Node} node - either the namespace name, or node with JSDoc tags to find namespace name for
 * @param {Map<string, any>} target - where the found namespace, and any intermediaries, should be saved to
 * @param {Function} [tagTest] - method to determine name-containing tag when looking for namespace name from JSDoc tags
 * @param {Function} [whenFound] - what to do when the destination namespace has been found
 * @returns {*} the destination namespace value from the target
 */
export const findNamespaces = (node, target, tagTest, whenFound = (_, e) => e) => {
    const [{comment, tagName: {escapedText: type} = {}} = {}] = typeof node === "string" ? [] : ts.getAllJSDocTags(node, ({tagName: {escapedText} = {}}) => tagTest(escapedText));
    const name = typeof node === "string" ? node : comment;
    const namespace = name?.split(".");
    
    while (name && namespace.length) {
        const part = namespace.shift();
        
        if (!target.has(part)) target.set(part, {members: new Map()});
        if (namespace.length) target = target.get(part).members;
        else return (typeof node === "string" ? target : target.set(part, whenFound({name, type, node}, target.get(part)))).get(part);
    }
};

/**
 * Get the qualified namespace name from a JSDoc tag's full name or type expression
 * @param {ts.JSDocTag} tag - the tag to get namespace name for
 * @returns {String} the qualified namespace name for a tag
 */
export const getNamespaceNameForTag = (tag) => {
    const traverseName = (node) => (node.name ? [...(node.expression ? traverseName(node.expression) : []), node.name.escapedText, ...(node.body ? traverseName(node.body) : [])] : [node.escapedText]);
    return [tag.fullName ?? tag.expression ?? {}].map(traverseName).flat(Infinity).filter(s => !!s).join(".");
};

/**
 * Re-evaluate a given set of JSDoc tags as some other kind of tag
 * @param {String} type - what synonymous tag should be used in-situ when determining actual tag type
 * @param {ts.JSDocTag[]} [tags] - "unknown" tags to re-evaluate as some other kind of tag
 * @returns {ts.JSDocTag[]} the re-evaluated tags, hopefully with expected type and metadata
 */
const resolveVirtualTags = (type, tags) => ((tags && ts.createSourceFile(".js", `/**\r\n${tags.map(({comment}) => ` * @${type} ${comment}`).join("\r\n")}\r\n */`)
    .endOfFileToken.jsDoc?.shift().tags) ?? []);

/**
 * Merge JSDoc template tags with node local declarations
 * @param {ts.Node} node - the node to merge template tags for
 * @returns {Map<string, {declarations: ts.TypeParameterDeclaration[]}>} new node locals including ones implicitly defined in template tags
 */
export const resolveNodeLocals = (node) => new Map([
    ...(node.locals?.entries() ?? []),
    ...(ts.isJSDoc(node) ? node.tags.filter(ts.isJSDocTemplateTag) : ts.getAllJSDocTags(node, ts.isJSDocTemplateTag))
        .flatMap(({typeParameters}) => typeParameters)
        .map((param) => ([param.name.escapedText, {declarations: [param]}]))
]);

/**
 * Extract any type definitions, callbacks, or class method types hiding in JSDoc comments
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.Node} node - any node from the AST that may contain implicit type definitions
 * @param {Map} namespaces - where these implicit types should be registered
 */
export const resolveImplicitTypeDefs = (checker, node, namespaces) => {
    for (let doc of (node.jsDoc ?? [])) {
        for (let tag of (doc.tags ?? []).filter((t) => ts.isJSDocCallbackTag(t) || ts.isJSDocTypedefTag(t) || ts.isJSDocEnumTag(t))) {
            if (tag.comment) findNamespaces(getNamespaceNameForTag(tag) || tag.comment.replace(/~.*$/, "") || checker.typeToString(checker.getTypeFromTypeNode(tag.typeExpression.type)), namespaces)
                ?.members?.set(tag.comment.replace(/^.*?~/, ""), {node: tag, source: node});
        }
        
        const hasTemplates = doc.tags?.some(t => ts.isJSDocTemplateTag(t) || isJSDocTypeParamTag(t));
        const hasTypeParams = hasTemplates && doc.tags.some(isJSDocTypeParamTag);
        
        if (hasTemplates && doc.tags.some(isJSDocAbstractTag) && !(doc.tags.some(ts.isJSDocPrivateTag) || ts.isPrivateIdentifier(node.name))) {
            const isStatic = node.modifiers?.some(isStaticModifier);
            const target = findNamespaces(node.parent, namespaces, (name) => ["namespace", "alias"].includes(name))?.members;
            
            if ((isStatic || hasTypeParams) && !target?.has(node.name.escapedText)) {
                const templates = (!(isStatic || hasTypeParams) ? doc.tags.filter(ts.isJSDocTemplateTag) : resolveVirtualTags("template", doc.tags.filter(isJSDocTypeParamTag)))?.flatMap(({typeParameters}) => typeParameters);
                const typeParams = templates?.filter(({name}) => !node.parent?.locals?.has(name?.escapedText));
                const signature = ts.factory.createJSDocSignature(typeParams, doc.tags.filter(ts.isJSDocParameterTag), doc.tags.find(ts.isJSDocReturnTag));
                const tag = ts.factory.createJSDocCallbackTag(undefined, signature);
                const parent = ts.factory.createJSDocComment(ts.getTextOfJSDocComment(doc.comment), [tag, ts.factory.createJSDocPrivateTag()]);
                const localTypes = [tag.typeExpression.type, ...tag.typeExpression.parameters]
                    .flatMap(({typeExpression} = {}) => typeExpression?.type?.types ?? typeExpression?.type ?? [])
                    .flatMap((type) => type?.typeName?.escapedText ?? []);
                const locals = (isStatic ? node.locals : new Map([...(node?.parent?.locals?.entries() ?? [])]
                    .filter(([name]) => localTypes.includes(name) && !templates?.some(({name: {escapedText}}) => name === escapedText))));
                
                target?.set(node.name.escapedText, {node: Object.assign(tag, {locals, parent}), source: node});
            }
        }
    }
};

/**
 * Resolve the actual type for a node, either directly from the node, or from JSDoc comments
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.Node} [node] - the node to resolve the actual type for
 * @param {Boolean} [isAsync=false] - whether the type should be wrapped in a Promise
 * @returns {ts.TypeNode} a type node valid for use wherever type nodes are expected
 */
export const resolveActualType = (checker, node, isAsync = false) => {
    if (isAsync) {
        return ts.factory.createTypeReferenceNode(ts.factory.createIdentifier("Promise"), [resolveActualType(checker, node)]);
    } else if (node) {
        switch (node.kind) {
            case ts.SyntaxKind.TypeQuery:
            case ts.SyntaxKind.TypeReference:
                return node;
            
            case ts.SyntaxKind.UnionType:
                return ts.factory.createUnionTypeNode(node.types.map((t) => resolveActualType(checker, t)));
            
            case ts.SyntaxKind.ArrayType:
                return ts.factory.createArrayTypeNode(resolveActualType(checker, node.elementType));
            
            default: {
                const type = checker.getTypeFromTypeNode(node);
                
                if (type.intrinsicName !== "error") return checker.typeToTypeNode(type);
                else return resolveActualType(checker, node.typeExpression ?? node.type);
            }
        }
    } else {
        return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
    }
};
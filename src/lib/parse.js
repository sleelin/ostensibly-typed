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
    // If node is a node, go look for JSDoc tags that could have a namespace...
    const [{comment, tagName: {escapedText: type} = {}} = {}] = typeof node === "string" ? [] : ts.getAllJSDocTags(node, ({tagName: {escapedText} = {}}) => tagTest(escapedText));
    // ...otherwise, node must be the namespace
    const name = typeof node === "string" ? node : comment;
    const namespace = name?.split(".");
    
    // Traverse it!
    while (name && namespace.length) {
        const part = namespace.shift();
        
        // Make sure intermediaries are defined
        if (!target.has(part)) target.set(part, {members: new Map()});
        // If more parts, keep digging
        if (namespace.length) target = target.get(part).members;
        // Otherwise, either return found target value, or do something to update the target value and return it
        else return (typeof node === "string" ? target : target.set(part, whenFound({name, type, node}, target.get(part)))).get(part);
    }
};

/**
 * Get the qualified namespace name from a JSDoc tag's full name or type expression
 * @param {ts.JSDocTag} tag - the tag to get namespace name for
 * @returns {String} the qualified namespace name for a tag
 */
export const getNamespaceNameForTag = (tag) => {
    // Deep dive into tag names, since there's no easy way to get the fullName of a TypeScript QualifiedName
    const traverseName = (node) => (node.name ? [...(node.expression ? traverseName(node.expression) : []), node.name.escapedText, ...(node.body ? traverseName(node.body) : [])] : [node.escapedText]);
    return [tag.fullName ?? tag.expression ?? {}].map(traverseName).flat(Infinity).filter(s => !!s).join(".");
};

/**
 * Re-evaluate a given set of JSDoc tags as some other kind of tag
 * @param {String} type - what synonymous tag should be used in-situ when determining actual tag type
 * @param {ts.JSDocTag[]} [tags] - "unknown" tags to re-evaluate as some other kind of tag
 * @returns {ts.JSDocTag[]} the re-evaluated tags, hopefully with expected type and metadata
 */
export const resolveVirtualTags = (type, tags) => ((tags?.length && ts.createSourceFile(".js", [`/**`, ...(type.match(/^prop(erty)?$/) ? [" * @typedef"] : []), ...tags.map(({comment}) => ` * @${type} ${ts.getTextOfJSDocComment(comment)}`), ` */`].join("\r\n"), ts.ScriptTarget.Latest, true)
    .endOfFileToken.jsDoc?.shift().tags) || []);

/**
 * Merge JSDoc template tags with node local declarations
 * @param {ts.Node} node - the node to merge template tags for
 * @returns {Map<string, {declarations: ts.TypeParameterDeclaration[]}>} new node locals including ones implicitly defined in template tags
 */
export const resolveNodeLocals = (node) => new Map([
    // Mix in existing locals, if any
    ...(node.locals?.entries() ?? []),
    // Grab all JSDoc @template tags and turn them into imposter locals
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
        // Grab any JSDoc annotations that are probably type declarations...
        for (let tag of (doc.tags ?? []).filter((t) => ts.isJSDocCallbackTag(t) || ts.isJSDocTypedefTag(t) || ts.isJSDocEnumTag(t))) {
            // ...find their parent namespace...
            if (tag.comment) findNamespaces(getNamespaceNameForTag(tag) || tag.comment.replace(/~.*$/, "") || checker.typeToString(checker.getTypeFromTypeNode(tag.typeExpression.type)), namespaces)
                // ...and save them for later!
                ?.members?.set(tag.comment.replace(/^.*?~/, ""), {node: tag, source: node});
        }
        
        // See if there's any JSDoc @template or @typeParam tags
        const hasTemplates = doc.tags?.some(t => ts.isJSDocTemplateTag(t) || isJSDocTypeParamTag(t));
        
        // If so, and it's not marked as private, it's probably an implicit callback type declaration
        if (hasTemplates && doc.tags.some(isJSDocAbstractTag) && !(doc.tags.some(ts.isJSDocPrivateTag) || ts.isPrivateIdentifier(node.name))) {
            // See if the node is a static class member, then see if there's specifically any @typeParam tags
            const isStatic = node.modifiers?.some(isStaticModifier);
            const hasTypeParams = hasTemplates && doc.tags.some(isJSDocTypeParamTag);
            // Find the parent namespace so we can save the declaration for later!
            const target = findNamespaces(node.parent, namespaces, (name) => ["namespace", "alias"].includes(name))?.members;
            
            // Only build the callback type declaration if we really must.
            if ((isStatic || hasTypeParams) && !target?.has(node.name.escapedText)) {
                // Get template tags, then get typeParams that aren't declared by the parent
                const templates = (!(isStatic || hasTypeParams) ? doc.tags.filter(ts.isJSDocTemplateTag) : resolveVirtualTags("template", doc.tags.filter(isJSDocTypeParamTag)))?.flatMap(({typeParameters}) => typeParameters);
                const typeParams = templates?.filter(({name}) => !node.parent?.locals?.has(name?.escapedText));
                // Create a new JSDoc signature for the callback, then create the callback!
                const signature = ts.factory.createJSDocSignature(typeParams, doc.tags.filter(ts.isJSDocParameterTag), doc.tags.find(ts.isJSDocReturnTag));
                const tag = ts.factory.createJSDocCallbackTag(undefined, signature);
                // Wrap the whole thing in a parent comment
                const parent = ts.factory.createJSDocComment(ts.getTextOfJSDocComment(doc.comment), [tag, ts.factory.createJSDocPrivateTag()]);
                // Do some magic to get locally declared type arguments
                const localTypes = [tag.typeExpression.type, ...tag.typeExpression.parameters]
                    .flatMap(({typeExpression} = {}) => typeExpression?.type?.types ?? typeExpression?.type ?? [])
                    .flatMap((type) => type?.typeName?.escapedText ?? []);
                // Then do some more magic to work out which ones actually belong to this callback
                const locals = (isStatic ? node.locals : new Map([...(node?.parent?.locals?.entries() ?? [])]
                    .filter(([name]) => localTypes.includes(name) && !templates?.some(({name: {escapedText}}) => name === escapedText))));
                
                // Save the declaration for later!
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
        // If the type is for an async context, wrap it in a Promise
        return ts.factory.createTypeReferenceNode(ts.factory.createIdentifier("Promise"), [resolveActualType(checker, node)]);
    } else if (node) {
        // See if TypeScript can guess the type
        const type = checker.getTypeFromTypeNode(node);
        const guessed = checker.typeToTypeNode(type);
        
        switch (node.kind) {
            // Assume "typeof" type queries are already correct 
            case ts.SyntaxKind.TypeQuery:
                return node;
            
            // Go through and resolve Union/Array type argument types
            case ts.SyntaxKind.UnionType:
                return ts.factory.createUnionTypeNode(node.types.map((t) => resolveActualType(checker, t)));
            case ts.SyntaxKind.ArrayType:
                return ts.factory.createArrayTypeNode(resolveActualType(checker, node.elementType));
            
            // Also go through and resolve TypeReference type arguments...
            case ts.SyntaxKind.TypeReference:
                // ...but only if TypeScript managed to guess some useful type reference
                if (guessed.typeName) return ts.factory.createTypeReferenceNode(guessed.typeName, node.typeArguments && node.typeArguments.map((t) => resolveActualType(checker, t)));
            
            // Otherwise, the TypeReference might actually be a primitive (╯°O°)╯︵ ┻━┻
            default: {
                // If it was a primitive, return it...
                if (type.intrinsicName !== "error") return guessed;
                // ...otherwise, dive deeper!
                else return resolveActualType(checker, node.typeExpression ?? node.type);
            }
        }
    } else {
        // If there was no node, assume the type is "void"
        return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
    }
};
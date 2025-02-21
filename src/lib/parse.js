import ts from "typescript";
import {isJSDocAbstractTag, isJSDocInternalTag, isJSDocPropertyTag, isJSDocTypeParamTag, isStaticModifier} from "./filter";

/**
 * Traverse to a given namespace in a map, then take some kind of action
 * @template {*} T - the type of the target entry in the map
 * @param {String|ts.Node} node - either the namespace name, or node with JSDoc tags to find namespace name for
 * @param {Map<String, T>} target - where the found namespace, and any intermediaries, should be saved to
 * @param {String[]} [tagNames] - method to determine name-containing tag when looking for namespace name from JSDoc tags
 * @param {Function} [whenFound] - what to do when the destination namespace has been found
 * @returns {T} the destination namespace value from the target
 */
export const findNamespaces = (node, target, tagNames = [], whenFound = (_, e) => e) => {
    // If node is a node, go look for JSDoc tags that could have a namespace...
    const [{comment, tagName: {escapedText: type} = {}} = {}] = typeof node === "string" ? [] : ts.getAllJSDocTags(node, ({tagName: {escapedText} = {}}) => tagNames.includes(escapedText));
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
        else return (typeof whenFound !== "function" ? target : target.set(part, whenFound({name, type, node}, target.get(part)))).get(part);
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
 * Resolve the fully qualified string value of a node's name, recursing into any qualified names
 * @param {...(ts.Identifier|ts.QualifiedName)} names - identifier or qualified name nodes to resolve
 * @returns {String} the string value of a name node, including any qualifiers
 */
export const resolveQualifiedName = (...names) => names.flatMap((name) => ts.isQualifiedName(name) ? resolveQualifiedName(name.left, name.right) : name.escapedText).join(".");

/**
 * Re-evaluate a given set of JSDoc tags as some other kind of tag
 * @param {String} type - what synonymous tag should be used in-situ when determining actual tag type
 * @param {ts.JSDocTag[]} [tags] - "unknown" tags to re-evaluate as some other kind of tag
 * @returns {ts.JSDocTag[]} the re-evaluated tags, hopefully with expected type and metadata
 */
export const resolveVirtualTags = (type, tags) => ((tags?.length && ts.createSourceFile(".js", [`/**`, ...(type.match(/^prop(erty)?$/) ? [" * @typedef"] : []), ...tags.map(({comment}) => ` * @${type} ${ts.getTextOfJSDocComment(comment)}`), ` */`].join("\r\n"), ts.ScriptTarget.Latest, true)
    // Look for set of JSDoc tags only, then if virtual tag was a type definition, handle understructured property tags
    .endOfFileToken.jsDoc?.shift().tags) || []).map((node) => !(node && ts.isJSDocTypedefTag(node) && ts.isJSDocTypeLiteral(node.typeExpression) && node.typeExpression.jsDocPropertyTags.some(({name}) => ts.isQualifiedName(name)))
    ? node : ts.factory.updateJSDocTypedefTag(node, node.tagName, ts.factory.updateJSDocTypeLiteral(node.typeExpression, resolveUnderstructuredTags(node.typeExpression.jsDocPropertyTags))));

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
 * Resolve the structure of a type annotation when a property-like tag has child properties and extends anything other than "object"
 * @param {ts.JSDocPropertyLikeTag[]} tags - parameter or property tags to restructure
 * @param {String} [name] - the fully qualified name of the containing property-like tag
 * @returns {ts.JSDocPropertyLikeTag[]} the correctly structured parameter or property tags
 */
export const resolveUnderstructuredTags = (tags, name) => tags.filter((tag) => !ts.isQualifiedName(tag.name) || (name && resolveQualifiedName(tag.name.left).startsWith(name))).map((tag) => ([
    // Find any unhandled tags that should be properties of this tag (i.e. children)
    tag, tags.filter((t) => ts.isQualifiedName(t.name) && resolveQualifiedName(t.name.left) === resolveQualifiedName(tag.name))
])).map(([tag, children]) => !children.length ? tag : (isJSDocPropertyTag(tag) ? ts.factory.createJSDocPropertyTag : ts.factory.createJSDocParameterTag)(
    tag.tagName, tag.name, tag.isBracketed,
    // If there were children, create a new intersection type with a new structured literal
    ts.factory.createJSDocTypeExpression(ts.factory.createIntersectionTypeNode([
        tag.typeExpression.type, ts.factory.createJSDocTypeLiteral(resolveUnderstructuredTags(children, resolveQualifiedName(tag.name)))
    ])),
    tag.isNameFirst,
    tag.comment
));

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
            // ...but only if they aren't internal
            if (!doc.tags.some(isJSDocInternalTag)) {
                // Then, find their parent namespace...
                if (tag.comment) findNamespaces(getNamespaceNameForTag(tag) || tag.comment.replace(/~.*$/, "") || checker.typeToString(checker.getTypeFromTypeNode(tag.typeExpression.type)), namespaces)
                    // ...and save them for later!
                    ?.members?.set(tag.comment.replace(/^.*?~/, ""), {node: tag, source: node});
                // If no comment, consider the type expression instead
                else if (tag.typeExpression)
                    findNamespaces(getNamespaceNameForTag(tag), namespaces, null, () => ({node: tag, source: node}));
            }
        }
        
        // See if there's any JSDoc @template or @typeParam tags
        const hasTemplates = doc.tags?.some(t => ts.isJSDocTemplateTag(t) || isJSDocTypeParamTag(t));
        // See if the node is a static class member, then see if there's specifically any @typeParam tags
        const isStatic = node.modifiers?.some(isStaticModifier);
        const hasTypeParams = hasTemplates && doc.tags.some(isJSDocTypeParamTag);
        
        // If so, and it's not marked as private, it's probably an implicit callback type declaration
        if (hasTemplates && (hasTypeParams || doc.tags.some(isJSDocAbstractTag)) && !(doc.tags.some(ts.isJSDocPrivateTag) || ts.isPrivateIdentifier(node.name))) {
            // Find the parent namespace so we can save the declaration for later!
            const target = findNamespaces(node.parent, namespaces, ["namespace", "alias"])?.members;
            
            // Only build the callback type declaration if we really must.
            if ((isStatic || hasTypeParams) && !target?.has(node.name.escapedText)) {
                // Get template tags, then get typeParams that aren't declared by the parent
                const templates = (!(isStatic || hasTypeParams) ? doc.tags.filter(ts.isJSDocTemplateTag) : resolveVirtualTags("template", doc.tags.filter(isJSDocTypeParamTag)))?.flatMap(({typeParameters}) => typeParameters);
                const typeParams = templates?.filter(({name}) => !node.parent?.locals?.has(name?.escapedText));
                // Create a new JSDoc signature for the callback, then create the callback!
                const signature = ts.factory.createJSDocSignature(typeParams.map(({parent}) => parent), doc.tags.filter(ts.isJSDocParameterTag), doc.tags.find(ts.isJSDocReturnTag));
                const tag = ts.factory.createJSDocCallbackTag(undefined, signature);
                // Wrap the whole thing in a parent comment
                const parent = ts.factory.createJSDocComment(ts.getTextOfJSDocComment(doc.comment), [...signature.typeParameters, tag, ts.factory.createJSDocPrivateTag()]);
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
            // Assume "typeof" and "keyof" type queries are already correct
            case ts.SyntaxKind.TypeOperator:
            case ts.SyntaxKind.TypeQuery:
                return node;
            
            // Go through and resolve Union/Intersection/Array type argument types
            case ts.SyntaxKind.UnionType:
                return ts.factory.createUnionTypeNode(node.types.map((t) => resolveActualType(checker, t)));
            case ts.SyntaxKind.IntersectionType:
                return ts.factory.createIntersectionTypeNode(node.types.map((t) => resolveActualType(checker, t)));
            case ts.SyntaxKind.ArrayType:
                return ts.factory.createArrayTypeNode(resolveActualType(checker, node.elementType));
            
            // Also go through and resolve TypeReference type arguments...
            case ts.SyntaxKind.TypeReference:
                // ...but only if TypeScript managed to guess some useful type reference
                if (ts.isQualifiedName(node.typeName) || guessed.typeName || (guessed.kind === ts.SyntaxKind.AnyKeyword && node.typeArguments))
                    return ts.factory.createTypeReferenceNode(guessed.typeName ?? node.typeName, node.typeArguments && node.typeArguments.map((t) => resolveActualType(checker, t)));
            
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
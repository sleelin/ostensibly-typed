import ts from "typescript";

/**
 * @callback JSDocTagTest
 * Type predicate testing method for a JSDoc tag
 * @param {ts.JSDocTag} tag - the tag to match tag name against
 * @returns {Boolean} whether the given tag's name matches a specified type
 */

/**
 * Get a type predicate comparison function for a given tag name
 * @param {String[]} names - expected JSDoc tag names
 * @returns {JSDocTagTest} whether the tag name matches the expected name
 */
const getTagNameComparisonMethod = (...names) => ({tagName: {escapedText} = {}}) => (names.includes(escapedText.toLowerCase()));

export const /** @type {Function} */ isJSDocAbstractTag = getTagNameComparisonMethod("abstract");
export const /** @type {Function} */ isJSDocExtendsTag = getTagNameComparisonMethod("extends");
export const /** @type {Function} */ isJSDocInheritDocTag = getTagNameComparisonMethod("inheritdoc");
export const /** @type {Function} */ isJSDocInternalTag = getTagNameComparisonMethod("internal");
export const /** @type {Function} */ isJSDocPropertyTag = getTagNameComparisonMethod("prop", "property");
export const /** @type {Function} */ isJSDocThrowsTag = getTagNameComparisonMethod("throws");
export const /** @type {Function} */ isJSDocTypeAnnotationTag = getTagNameComparisonMethod("callback", "enum", "overload", "typedef");
export const /** @type {Function} */ isJSDocTypeParamTag = getTagNameComparisonMethod("typeparam");

/**
 * Check whether the type for the given node can be instantiated
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.Node} node - the node to check type for
 * @returns {Boolean} whether the given node's type has a constructor or new property
 */
export const isConstructableType = (checker, node) => {
    const type = checker.getTypeFromTypeNode(node);
    return (!!type.intrinsicName || checker.getTypeOfSymbolAtLocation(type.getSymbol(), type.getSymbol().valueDeclaration).isClassOrInterface());
};

/**
 * Check whether a given node represents an optional type
 * @param {ts.JSDocTag} node - the node being tested
 * @returns {Boolean} whether the node represents an optional type
 */
export const isOptionalType = (node) => (node.isBracketed || (node.typeExpression?.type && ts.isJSDocOptionalType(node.typeExpression.type)));

/**
 * Check whether a given modifier node is for the static keyword
 * @param {ts.Modifier} node - modifier whose kind should be checked
 * @returns {Boolean} whether the node was a static modifier
 */
export const isStaticModifier = ({kind}) => (kind === ts.SyntaxKind.StaticKeyword);

/**
 * Check whether a given heritage node is for the extends keyword
 * @param {ts.Modifier} node - modifier whose token should be checked
 * @returns {Boolean} whether the node was an extends clause
 */
export const isExtendsClause = ({token}) => (token === ts.SyntaxKind.ExtendsKeyword);

/**
 * Check whether a given get accessor has a corresponding set accessor
 * @param {ts.Node} node - the node to find a matching set accessor for
 * @returns {Boolean} whether the node can be described as read-only
 */
export const isReadOnlyAccessor = (node) => !node?.parent?.members?.some((m) => ts.isSetAccessor(m) && m.name?.escapedText === node.name.escapedText);

/**
 * Check whether a given node is a return statement for a literal expression
 * @param {ts.Node} node - the node to check for a literal return type
 * @returns {Boolean} whether the node is a return statement with a literal return type
 */
export const isLiteralReturnType = (node) => !!node && ts.isReturnStatement(node)
    && [ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.expression.kind);

/**
 * Remove any private, internal, unnamed, or otherwise irrelevant members from a class
 * @param {String} type - what kind of class is being declared
 * @param {ts.Node[]} members - all members defined for a class
 * @returns {ts.Node[]} any members that actually need documenting
 */
export const filterMembers = (type, members) => members.filter((m) => (
    (!m.name || (!ts.isPrivateIdentifier(m.name) && (type === "namespace"
        ? (m.name.escapedText !== m.initializer?.escapedText || !!ts.getJSDocTypeTag(m))
        : (!m.modifiers?.some(({kind}) => kind === ts.SyntaxKind.PrivateKeyword)))))
    && !ts.getAllJSDocTags(m, (t) => isJSDocInternalTag(t) || isJSDocInheritDocTag(t)).length)
);
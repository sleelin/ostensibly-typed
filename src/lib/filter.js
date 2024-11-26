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
export const /** @type {Function} */ isJSDocTypeParamTag = getTagNameComparisonMethod("typeparam");

/**
 * Check whether a given modifier node is for the static keyword
 * @param {ts.Modifier} node - modifier whose kind should be checked
 * @returns {Boolean} whether the node was a static modifier
 */
export const isStaticModifier = ({kind}) => (kind === ts.SyntaxKind.StaticKeyword);

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
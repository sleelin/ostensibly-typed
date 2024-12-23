import ts from "typescript";
import {isJSDocTypeAnnotationTag} from "./filter.js";

/**
 * Standardise a JSDoc comment to TSDoc format
 * @param {String} comment - text to transform into standard TSDoc format
 * @returns {String} the TSDoc formatted comment
 */
export const standardiseComment = (comment) => comment.replace(/^([-*]\s+)?(.)(.*)/, (_, __, p1, p2) => `${p1.toUpperCase()}${p2}`);

/**
 * Extract and format all JSDoc parameter and return tags
 * @param {ts.JSDocTag[]} [tags] - all JSDoc tags belonging to a comment
 * @param {ts.JSDocReturnTag} [returns] - the return tag to document
 * @returns {ts.JSDocTag[]} the parameter and return tags 
 */
export const annotateParams = (tags, returns) => tags?.filter((tag) => ts.isJSDocParameterTag(tag))
    .map((tag) => ([tag, ...(ts.isJSDocTypeLiteral(tag.typeExpression.type) ? tag.typeExpression.type.jsDocPropertyTags : [])])).flat()
    .map((tag) => ts.factory.createJSDocParameterTag(tag.tagName, tag.name, false, undefined, tag.isNameFirst, standardiseComment(ts.getTextOfJSDocComment(tag.comment))))
    .concat(...(returns?.comment ? ts.getTextOfJSDocComment(returns.comment).split("\n").map((c) => ts.factory.createJSDocReturnTag(returns.tagName, undefined, standardiseComment(c))) : []));

/**
 * Annotate a single property of a type or class
 * @param {ts.JSDoc} prop - the property to annotate
 * @returns {ts.JSDoc[]} the annotated property
 */
export const annotateProp = (prop) => (prop?.comment ? [ts.factory.createJSDocComment(standardiseComment(ts.getTextOfJSDocComment(prop.comment)), [])] : []);

/**
 * Annotate a class method or property accessor, including parameters and return value
 * @param {ts.ConstructorDeclaration|ts.MethodDeclaration|ts.AccessorDeclaration} node - the class method or property accessor to annotate
 * @returns {JSDoc[]} the documentation comment describing the method
 */
export const annotateMethod = (node) => (node.jsDoc ?? []).flatMap(({comment, tags}) => ((comment && !tags?.some(isJSDocTypeAnnotationTag)) || tags?.some((tag) => ts.isJSDocParameterTag(tag) && tag.comment)) ? [ts.factory.createJSDocComment(comment, annotateParams(tags, tags.find(ts.isJSDocReturnTag)))] : []);

/**
 * Annotate a function type expression, including parameters and return value
 * @param {ts.JSDocCallbackTag} node - the callback tag representing the function type expression
 * @returns {ts.JSDoc[]} the documentation comment describing the function type
 */
export const annotateFunction = (node) => (node.parent?.comment ? [ts.factory.createJSDocComment(node.parent.comment, annotateParams(node.typeExpression.parameters, node.typeExpression.type))] : []);

/**
 * Add a remark as a leading synthetic comment to a node
 * @param {ts.Node} node - the node to prepend the remark to
 * @param {String} [comment] - the comment to prepend to the node, if any
 * @returns {ts.Node} the original node, with possible leading comment
 */
export const annotateRemark = (node, comment) => comment ? ts.addSyntheticLeadingComment(node, ts.SyntaxKind.SingleLineCommentTrivia, ` ${comment}`) : node;

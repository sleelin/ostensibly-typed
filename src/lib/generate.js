import ts from "typescript";
import {findNamespaces, getNamespaceNameForTag, resolveActualType, resolveNodeLocals, resolveVirtualTags} from "./parse.js";
import {filterMembers, isJSDocAbstractTag, isJSDocExtendsTag, isJSDocPropertyTag, isStaticModifier} from "./filter";
import {annotateFunction, annotateMethod, annotateProp} from "./annotate.js";

/**
 * Generate type parameter declarations from node locals
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {Map<string, {declarations: ts.Node[]}>} locals - node locals
 * @returns {ts.TypeParameterDeclaration[]} type parameter declarations for the given node
 */
const generateTypeParameterDeclarations = (checker, locals) => (locals && Array.from(locals.values(), ({declarations}) => declarations)
    .flat().filter(ts.isTypeParameterDeclaration).map((type) => ts.factory.createTypeParameterDeclaration(
        undefined, type.name, type.parent.constraint && resolveActualType(checker, type.parent.constraint.type), type.default
    ))
);

/**
 * Generate parameter declarations for a function using explicit or implied JSDoc parameter definitions
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.ParameterDeclaration[]} params - list of function parameters to generate explicit declarations for
 * @returns {ts.ParameterDeclaration[]} list of function parameters sourced directly and indirectly from JSDoc tags
 */
const generateParameterDeclarations = (checker, params) => params.map((node) => ([node, ts.isJSDocParameterTag(node) ? [node] : ts.getJSDocParameterTags(node)])).flatMap(([node, tags]) => ts.factory.createParameterDeclaration(
    node.modifiers, node.dotDotDotToken, node.name,
    tags.some(({isBracketed}) => isBracketed) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
    tags.length > 1 ? ts.factory.createUnionTypeNode(tags.map((t) => resolveActualType(checker, t))) : resolveActualType(checker, tags[0]))
);

/**
 * Generate annotation and declaration for a given property definition
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.PropertyDeclaration|ts.JSDocPropertyTag} node - property definition to annotate and resolve typing for
 * @returns {(ts.JSDoc|ts.PropertyDeclaration)[]} property annotation and declaration
 */
const generatePropertyDeclaration = (checker, node) => ([
    ...annotateProp(ts.isJSDocPropertyTag(node) ? node : node.jsDoc?.slice(-1)?.pop()),
    ts.factory.createPropertyDeclaration(
        node.modifiers, node.name,
        node.isBracketed ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
        node.typeExpression?.type && ts.isJSDocTypeLiteral(node.typeExpression.type) ? (
            generateTypeDefType(checker, node.typeExpression.type)
        ) : (
            resolveActualType(checker, ts.getJSDocTypeTag(node) ?? node.typeExpression)
        )
    )
]);

/**
 * Generate annotation and declaration for a given constructor definition, including any JSDoc property tags
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.ConstructorDeclaration} node - the class constructor declaration to annotate and declare
 * @returns {(ts.SyntaxKind.JSDoc|ts.ConstructorDeclaration)[]} annotated properties, constructor annotation and declaration
 */
const generateConstructorDeclaration = (checker, node) => ([
    ...(resolveVirtualTags("prop", ts.getAllJSDocTags(node, isJSDocPropertyTag)).shift()?.typeExpression?.jsDocPropertyTags ?? [])
        .flatMap((node) => generatePropertyDeclaration(checker, node)),
    ...annotateMethod(node),
    ts.factory.createConstructorDeclaration(node.modifiers, generateParameterDeclarations(checker, node.parameters))
]);

/**
 * Generate an accurately typed declaration for a method-like class member
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.GetAccessorDeclaration|ts.SetAccessorDeclaration|ts.MethodDeclaration} node - method-like class member node to accurately declare
 * @param {Map<string, any>} namespaces - where to source inherited declaration details from
 * @returns {ts.GetAccessorDeclaration|ts.SetAccessorDeclaration|ts.PropertyDeclaration|ts.MethodDeclaration} updated method-like class member
 */
const generateMethodDeclaration = (checker, node, namespaces) => {
    const [abstractTag] = ts.getAllJSDocTags(node, isJSDocAbstractTag);
    const [implementsTag] = ts.getJSDocImplementsTags(node);
    const modifiers = node.modifiers?.filter(({kind}) => kind !== ts.SyntaxKind.AsyncKeyword);
    const templates = node.typeParameters ?? generateTypeParameterDeclarations(checker, node.locals);
    const parameters = generateParameterDeclarations(checker, node.parameters);
    let type = ts.getJSDocTypeTag(node);
    
    if (ts.isAccessor(node) && (type || implementsTag?.class?.typeArguments?.length)) {
        if (!type && implementsTag?.class?.typeArguments?.length) {
            const {name} = implementsTag.class.expression;
            const source = findNamespaces(getNamespaceNameForTag(implementsTag.class.expression), namespaces).node;
            
            type = ts.getJSDocTypeTag(source.members.find((m) => ts.isGetAccessorDeclaration(m) && m.name.escapedText === name.escapedText));
        }
        
        return [
            ...annotateMethod(node),
            ts.isGetAccessorDeclaration(node) ? (
                ts.factory.createGetAccessorDeclaration(modifiers, node.name, parameters, resolveActualType(checker, type))
            ) : (
                ts.factory.createSetAccessorDeclaration(modifiers, node.name, parameters)
            )
        ];
    }
    else if (type)
        return [...annotateMethod(node), ts.factory.createPropertyDeclaration(modifiers, node.name, node.questionToken, resolveActualType(checker, type))];
    else if (abstractTag && templates.length && modifiers.some(isStaticModifier)) {
        const name = ts.factory.createQualifiedName(node.parent.name, node.name);
        const type = ts.factory.createTypeReferenceNode(name, Array(templates.length).fill(ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)));
        
        return [...annotateMethod(node), ts.factory.createPropertyDeclaration(modifiers, node.name, node.questionToken, type)];
    }
    else if (implementsTag?.class?.typeArguments?.length)
        return [...annotateMethod(node), ts.factory.createPropertyDeclaration(modifiers, node.name, node.questionToken, implementsTag.class)];
    else if (!implementsTag) {
        const overloads = ts.getAllJSDocTags(node, ts.isJSDocOverloadTag);
        
        return [
            ...overloads.flatMap((tag) => ([
                ...annotateFunction(tag), ts.factory.createMethodDeclaration(
                    modifiers, node.asteriskToken, node.name, node.questionToken,
                    generateTypeParameterDeclarations(checker, resolveNodeLocals(tag.parent)),
                    generateParameterDeclarations(checker, tag.typeExpression.parameters),
                    resolveActualType(checker, tag.typeExpression.type, node.modifiers?.some(({kind}) => kind === ts.SyntaxKind.AsyncKeyword))
                )
            ])),
            ...annotateMethod(node), ts.factory.createMethodDeclaration(
                modifiers, node.asteriskToken, node.name, node.questionToken, !overloads.length ? templates : undefined, parameters,
                resolveActualType(checker, ts.getJSDocReturnTag(node), node.modifiers?.some(({kind}) => kind === ts.SyntaxKind.AsyncKeyword))
            )
        ];
    }
};

/**
 * Generate a type literal from a JSDoc typedef tag's type expression
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.JSDocTypeExpression} typeExpression - the JSDoc type expression of a JSDoc typedef tag
 * @returns {ts.TypeLiteralNode} an accurately typed declaration of the JSDoc type expression
 */
const generateTypeDefType = (checker, typeExpression) => ts.factory.createTypeLiteralNode(
    typeExpression.jsDocPropertyTags.flatMap((node) => ([
        ...annotateProp(node),
        ts.factory.createPropertySignature(
            undefined, ts.isQualifiedName(node.name) ? node.name.right : node.name,
            node.isBracketed ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
            ts.isTypeNode(node.typeExpression.type) ? (
                resolveActualType(checker, node.typeExpression.type)
            ) : node.typeExpression.type.isArrayType ? (
                ts.factory.createTypeReferenceNode(ts.factory.createIdentifier("Array"), [generateTypeDeclaration(checker, node.typeExpression.type)])
            ) : (
                generateTypeDeclaration(checker, node.typeExpression.type)
            )
        )
    ]))
);

/**
 * Generate a type literal declaration from a property assignment or declaration documented as an ENUM
 * @param {ts.PropertyAssignment|ts.PropertyDeclaration} source - the node which contains values to treat as enum members
 * @returns {ts.UnionTypeNode} type containing all values converted to type literals
 */
const generateEnumType = (source) => ts.factory.createUnionTypeNode(
    (ts.isPropertyAssignment(source) ? [source] : source.declarationList.declarations)
        .map(({initializer}) => initializer.elements.map((type) => ts.factory.createLiteralTypeNode(
            ts.isNumericLiteral(type) ? ts.factory.createNumericLiteral(type.text) : ts.factory.createStringLiteral(type.text)))
        )
        .flatMap((types, _, declarations) => declarations.length > 1 ? ts.factory.createUnionTypeNode(types) : types)
);

/**
 * Generate a function type from a JSDoc callback tag
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.JSDocCallbackTag} typeExpression - the callback tag's type expression declaration
 * @param {ts.Node} source - original node associated with the callback tag
 * @returns {ts.FunctionTypeNode} function type declaration for the callback tag
 */
const generateCallbackType = (checker, typeExpression, source) => ts.factory.createFunctionTypeNode(
    typeExpression.typeParameters,
    typeExpression.parameters?.map((node) => ts.factory.createParameterDeclaration(
        undefined, undefined, node.name,
        node.isBracketed ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
        node.type ?? resolveActualType(checker, node.typeExpression?.type ?? node?.type ?? node),
        undefined
    )),
    resolveActualType(checker, typeExpression.type, source?.modifiers?.some(({kind}) => kind === ts.SyntaxKind.AsyncKeyword))
);

/**
 * Generate type declarations from JSDoc types and tags
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.JSDocTypedefTag|ts.JSDocTypeLiteral|ts.JSDocEnumTag|ts.JSDocCallbackTag} node - JSDoc tag or type to generate declarations for
 * @param {ts.Node} source - original node associated with the callback tag
 * @returns {ts.TypeLiteralNode|ts.UnionTypeNode|ts.FunctionTypeNode|undefined} generated type declaration for the given JSDoc node
 */
const generateTypeDeclaration = (checker, node, source) => (
    ts.isJSDocTypedefTag(node) ? generateTypeDefType(checker, node.typeExpression) :
    ts.isJSDocTypeLiteral(node) ? generateTypeDefType(checker, node) :
    ts.isJSDocEnumTag(node) ? generateEnumType(source) :
    ts.isJSDocCallbackTag(node) ? generateCallbackType(checker, node.typeExpression, source) :
    undefined
);

/**
 * Generate heritage clauses for a class, using both explicit clauses and JSDoc heritage clause tags
 * @param {ts.ClassDeclaration} node - the class to generate heritage clauses for
 * @returns {[ts.HeritageClause,ts.HeritageClause]} extends and implements heritage clauses for the given class
 */
const generateClassHeritageClauses = (node) => ([
    ts.factory.createHeritageClause(
        ts.SyntaxKind.ExtendsKeyword, Array.from(new Map([
            ...(node.heritageClauses?.find(({token}) => token === ts.SyntaxKind.ExtendsKeyword)?.types ?? []),
            ...ts.getAllJSDocTags(node, isJSDocExtendsTag).map((tag) => tag.class)
        ].map((type) => ([ts.isIdentifier(type.expression) ? type.expression.escapedText : type.expression.name?.escapedText, type]))).values())
    ),
    ts.factory.createHeritageClause(
        ts.SyntaxKind.ImplementsKeyword, ts.getAllJSDocTags(node, ts.isJSDocImplementsTag).map((tag) => tag.class)
    )
]);

/**
 * Generate annotation and declarations for various types of class member
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.Node} node - the class member to annotate and declare
 * @param {Map<string, any>} namespaces - where to source inherited declaration details from
 * @returns {(ts.JSDoc|ts.ConstructorDeclaration|ts.GetAccessorDeclaration|ts.SetAccessorDeclaration|ts.PropertyDeclaration|ts.MethodDeclaration)[]} annotated member declaration
 */
const generateMemberDeclaration = (checker, node, namespaces) => {
    switch (node.kind) {
        case ts.SyntaxKind.PropertyDeclaration:
            return generatePropertyDeclaration(checker, node);
        case ts.SyntaxKind.Constructor:
            return generateConstructorDeclaration(checker, node);
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.MethodDeclaration:
            return generateMethodDeclaration(checker, node, namespaces) ?? [];
        default:
            return node;
    }
};

/**
 * Recursively generate module and namespace declarations from a given set of structured definitions
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.StringLiteral} name - string literal identifier for this namespace/module declaration
 * @param {ts.SyntaxKind.DeclareKeyword|ts.SyntaxKind.ExportKeyword} modifier - whether the declaration is a top-level module declaration or a nested namespace export
 * @param {Map<string, any>} members - any namespaces or type definitions that should be included in this namespace/module
 * @param {Map<string, any>} [namespaces=members] - the top-level set of structured definitions for sourcing inheritance
 * @returns {ts.ModuleDeclaration} module or namespace declaration with annotation and nested declarations
 */
export const generateNamespaceDeclarations = (checker, name, modifier, members, namespaces = members) => ts.factory.createModuleDeclaration(
    [ts.factory.createToken(modifier)], name, ts.factory.createModuleBlock(
        Array.from(members.entries(), ([name, {type, node, members, source}]) => ([
            ...(modifier === ts.SyntaxKind.DeclareKeyword ? [
                ts.factory.createExportDefault(node.name),
                ...Array.from(members.entries(), ([, {node: {name}}]) => ts.factory.createVariableStatement(
                    [ts.factory.createToken(ts.SyntaxKind.ExportKeyword), ts.factory.createToken(ts.SyntaxKind.ConstKeyword)],
                    ts.factory.createVariableDeclaration(name, undefined, ts.factory.createPropertyAccessExpression(node.name, name))
                ))
            ] : []),
            ...(!!type ? [
                ...(filterMembers(type, node.members).length ? [
                    ts.factory.createClassDeclaration(
                        node.modifiers.filter(({kind}) => kind !== ts.SyntaxKind.DefaultKeyword), node.name,
                        generateTypeParameterDeclarations(checker, resolveNodeLocals(node)),
                        generateClassHeritageClauses(node).filter(({types}) => types?.length),
                        ts.factory.createNodeArray(filterMembers(type, node.members).flatMap(node => generateMemberDeclaration(checker, node, namespaces)))
                    )
                ] : []),
                ...(members?.size ? [generateNamespaceDeclarations(checker, ts.factory.createIdentifier(name), ts.SyntaxKind.ExportKeyword, members, namespaces)] : [])
            ] : node ? [
                ...(ts.isJSDocCallbackTag(node) ? annotateFunction(node) : annotateProp(node.parent)),
                ts.factory.createTypeAliasDeclaration(
                    node.parent.tags?.some(ts.isJSDocPrivateTag) ? [] : [ts.factory.createToken(modifier)],
                    ts.factory.createIdentifier(name),
                    generateTypeParameterDeclarations(checker, node.locals),
                    generateTypeDeclaration(checker, node, source)
                )
            ] : [])
        ])).flat()
    ),
    modifier === ts.SyntaxKind.ExportKeyword ? ts.NodeFlags.Namespace : undefined
);
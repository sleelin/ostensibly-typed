import ts from "typescript";
import {findNamespaces, getNamespaceNameForTag, resolveActualType, resolveNodeLocals, resolveVirtualTags, resolveUnderstructuredTags, resolveQualifiedName} from "./parse.js";
import {filterMembers, isJSDocAbstractTag, isJSDocExtendsTag, isJSDocPropertyTag, isJSDocThrowsTag, isConstructableType, isOptionalType, isReadOnlyAccessor, isStaticModifier, isExtendsClause} from "./filter";
import {annotateFunction, annotateMethod, annotateProp} from "./annotate.js";

/**
 * Generate type parameter declarations from node locals
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {Map<string, {declarations: ts.Node[]}>} locals - node locals
 * @returns {ts.TypeParameterDeclaration[]} type parameter declarations for the given node
 */
const generateTypeParameterDeclarations = (checker, locals) => (locals && Array.from(locals.values(), ({declarations}) => declarations)
    .flat().filter(ts.isTypeParameterDeclaration).map((type) => ts.factory.createTypeParameterDeclaration(
        undefined, type.name,
        type.parent.constraint && resolveActualType(checker, type.parent.constraint.type),
        type.default && resolveActualType(checker, type.default)
    ))
);

/**
 * Generate a qualified name node for a given namespace, or a plain identifier for an unqualified name
 * @param {String} namespace - the namespace to generate the qualified name or plain identifier node for
 * @returns {ts.Identifier|ts.QualifiedName} the qualified name node, or identifier node for unqualified names
 */
const generateQualifiedName = (namespace) => namespace.split(".").map(ts.factory.createIdentifier)
    .reduce((left, right) => !left ? right : ts.factory.createQualifiedName(left, right), null);

/**
 * Potentially wrap a given type in an Array type reference
 * @param {ts.Node} type - the underlying type to be wrapped
 * @param {Boolean} [isArrayType] - whether the type should be wrapped
 * @returns {ts.Node|ts.TypeReferenceNode} the original type node, or a new Array type reference wrapping the type node
 */
const generateArrayTypeWrapper = (type, isArrayType) => !isArrayType ? type : ts.factory.createTypeReferenceNode(ts.factory.createIdentifier("Array"), [type]);

/**
 * Generate a type node for the given type, handling intersection types and additional emit flags
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.Node} node - the original node whose type needs generating
 * @param {ts.EmitFlags} [flags] - any additional emit flags to set on the node
 * @returns {ts.IntersectionTypeNode|ts.TypeNode} the newly generated or resolved type
 */
const generateTypeNode = (checker, node, flags) => node?.typeExpression && ts.isJSDocTypeExpression(node.typeExpression) && ts.isIntersectionTypeNode(node.typeExpression.type) ? (
    // Translate JSDoc intersection type expressions into their real types
    ts.factory.createIntersectionTypeNode([node.typeExpression.type.types.at(0), generateTypeNode(checker, node.typeExpression.type.types.at(1), flags)])
) : node?.typeExpression?.type ? (
    ts.isJSDocTypeLiteral(node.typeExpression.type) ? (
        // Generate type literals from JSDoc type literals
        generateArrayTypeWrapper(ts.setEmitFlags(generateTypeDefType(checker, node.typeExpression.type), flags), node.typeExpression.type.isArrayType)
    ) : (
        // Try to get the best guess type of the node...
        ts.isTypeNode(node.typeExpression.type) ? (resolveActualType(checker, node.typeExpression.type)) : (generateTypeDeclaration(checker, node.typeExpression.type))
    )
) : (
    // No type expression or type literal, try again with some other guesswork...
    ts.setEmitFlags(generateTypeDefType(checker, (node && ts.getJSDocTypeTag(node)) ?? node?.typeExpression?.type ?? node?.typeExpression ?? node), flags)
);

/**
 * Generate parameter declarations for a function using explicit or implied JSDoc parameter definitions
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.ParameterDeclaration[]} params - list of function parameters to generate explicit declarations for
 * @returns {ts.ParameterDeclaration[]} list of function parameters sourced directly and indirectly from JSDoc tags
 */
const generateParameterDeclarations = (checker, params) => params.map((node) => ([
    // Focus on the specified parameter tag, or handle understructured parameter tag annotations
    node, ts.isJSDocParameterTag(node) ? [node] : resolveUnderstructuredTags(ts.getAllJSDocTags(node.parent, ts.isJSDocParameterTag).filter((tag) => resolveQualifiedName(tag.name).startsWith(resolveQualifiedName(node.name))))
])).flatMap(([node, tags]) => ts.factory.createParameterDeclaration(
    node.modifiers, node.dotDotDotToken, node.name,
    tags.some(isOptionalType) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
    generateArrayTypeWrapper(
        tags.length > 1 ? (
            // Handle parameters with a variadic type
            ts.factory.createUnionTypeNode(tags.map((t) => generateTypeNode(checker, t, ts.EmitFlags.SingleLine)).map((t) => !!node.dotDotDotToken && ts.isArrayTypeNode(t) ? t.elementType : t))
        ) : (
            // Or just get the parameter type
            generateTypeNode(checker, tags[0], ts.EmitFlags.SingleLine)
        ),
        !!node.dotDotDotToken
    )
));

/**
 * Generate annotation and declaration for a given property definition
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.PropertyDeclaration|ts.JSDocPropertyTag} node - property definition to annotate and resolve typing for
 * @returns {(ts.JSDoc|ts.PropertyDeclaration)[]} property annotation and declaration
 */
const generatePropertyDeclaration = (checker, node) => ([
    ...annotateProp(ts.isJSDocPropertyTag(node) ? node : node.jsDoc?.slice(-1)?.pop()),
    ts.factory.createPropertyDeclaration(
        node.modifiers, ts.isQualifiedName(node.name) ? node.name.right : node.name,
        isOptionalType(node) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
        generateTypeNode(checker, node)
    )
]);

/**
 * Generate annotation and declaration for a given constructor definition, including any JSDoc property tags
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.ConstructorDeclaration} node - the class constructor declaration to annotate and declare
 * @returns {(ts.SyntaxKind.JSDoc|ts.ConstructorDeclaration)[]} annotated properties, constructor annotation and declaration
 */
const generateConstructorDeclaration = (checker, node) => ([
    // Declare properties that were described by @parameter tags on a constructor's annotation
    ...(resolveVirtualTags("prop", ts.getAllJSDocTags(node, isJSDocPropertyTag)).shift()?.typeExpression?.jsDocPropertyTags ?? [])
        .flatMap((node) => generatePropertyDeclaration(checker, node)),
    // Handle @overload annotations on the constructor
    ...ts.getAllJSDocTags(node, ts.isJSDocOverloadTag).flatMap((tag) => ([
        ...annotateFunction(tag), ts.factory.createConstructorDeclaration(undefined, generateParameterDeclarations(checker, tag.typeExpression.parameters))
    ])),
    // Annotate and declare the constructor
    ...annotateMethod(node), ts.factory.createConstructorDeclaration(node.modifiers, generateParameterDeclarations(checker, node.parameters))
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
    const questionToken = isOptionalType(node) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken;
    let type = ts.getJSDocTypeTag(node);
    
    // Handle property accessor methods with type annotations
    if (ts.isAccessor(node) && (type || implementsTag?.class?.typeArguments?.length)) {
        // Resolve any inherited types from implements tags
        if (!type && implementsTag?.class?.typeArguments?.length) {
            const {name} = implementsTag.class.expression;
            const source = findNamespaces(getNamespaceNameForTag(implementsTag.class.expression), namespaces).node;
            
            type = ts.getJSDocTypeTag(source.members.find((m) => ts.isGetAccessorDeclaration(m) && m.name.escapedText === name.escapedText));
        }
        
        return [
            ...annotateMethod(node),
            ts.isGetAccessorDeclaration(node) ? isReadOnlyAccessor(node) ? (
                // If property has no set accessor, declare it as read-only
                ts.factory.createPropertyDeclaration([...modifiers, ts.factory.createToken(ts.SyntaxKind.ReadonlyKeyword)], node.name, questionToken, resolveActualType(checker, type))
            ) : (
                // Otherwise, declare get accessor...
                ts.factory.createGetAccessorDeclaration(modifiers, node.name, parameters, resolveActualType(checker, type))
            ) : (
                // ...or set accessor
                ts.factory.createSetAccessorDeclaration(modifiers, node.name, parameters)
            )
        ];
    }
    // Handle explicitly typed methods...
    else if (type)
        // ...by treating them as property declarations instead
        return [...annotateMethod(node), ts.factory.createPropertyDeclaration(modifiers, node.name, questionToken, resolveActualType(checker, type))];
    // Also treat abstract static methods with templates as properties...
    else if (abstractTag && templates.length && modifiers.some(isStaticModifier)) {
        const name = ts.factory.createQualifiedName(node.parent.name, node.name);
        const type = ts.factory.createTypeReferenceNode(name, Array(templates.length).fill(ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)));
        
        return [...annotateMethod(node), ts.factory.createPropertyDeclaration(modifiers, node.name, questionToken, type)];
    }
    // ...as well as methods with valid implements tags!
    else if (implementsTag?.class?.typeArguments?.length)
        return [...annotateMethod(node), ts.factory.createPropertyDeclaration(modifiers, node.name, questionToken, implementsTag.class)];
    // Finally, if all else fails, just declare the method!
    else if (!implementsTag) {
        const overloads = ts.getAllJSDocTags(node, ts.isJSDocOverloadTag);
        
        return [
            // Handle @overload annotations for the method
            ...overloads.flatMap((tag) => ([
                ...annotateFunction(tag), ts.factory.createMethodDeclaration(
                    modifiers, node.asteriskToken, node.name,
                    isOptionalType(node) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
                    generateTypeParameterDeclarations(checker, resolveNodeLocals(tag.parent)),
                    generateParameterDeclarations(checker, tag.typeExpression.parameters),
                    tag.parent.tags?.some(isJSDocThrowsTag) ? (
                        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
                    ) : (
                        resolveActualType(checker, tag.typeExpression.type, node.modifiers?.some(({kind}) => kind === ts.SyntaxKind.AsyncKeyword))
                    )
                )
            ])),
            // Annotate and declare the method
            ...annotateMethod(node), ts.factory.createMethodDeclaration(
                modifiers, node.asteriskToken, node.name, questionToken, !overloads.length ? templates : undefined, parameters,
                ts.getAllJSDocTags(node, isJSDocThrowsTag).length ? (
                    ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
                ) : (
                    resolveActualType(checker, ts.getJSDocReturnTag(node), node.modifiers?.some(({kind}) => kind === ts.SyntaxKind.AsyncKeyword))
                )
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
const generateTypeDefType = (checker, typeExpression) => typeExpression?.jsDocPropertyTags ? (
    ts.factory.createTypeLiteralNode(typeExpression.jsDocPropertyTags.flatMap((node) => generatePropertyDeclaration(checker, node)))
) : (
    resolveActualType(checker, typeExpression?.type ?? typeExpression)
);

/**
 * Generate a type literal declaration from a property assignment or declaration documented as an ENUM
 * @param {ts.JSDocTypeExpression} typeExpression - the callback tag's type expression declaration
 * @param {ts.PropertyAssignment|ts.PropertyDeclaration} source - the node which contains values to treat as enum members
 * @returns {ts.UnionTypeNode} type containing all values converted to type literals
 */
const generateEnumType = (typeExpression, source) => ts.factory.createUnionTypeNode(
    // Handle enums with explicit type annotations
    ts.isUnionTypeNode(typeExpression?.type) ? typeExpression.type.types
        .map(({literal: type}) => ts.factory.createLiteralTypeNode(ts.isNumericLiteral(type) ? ts.factory.createNumericLiteral(type.text) : ts.factory.createStringLiteral(type.text)))
    // Otherwise, see if we can get the types from a property or variable assignment value
    : (ts.isPropertyAssignment(source) ? [source] : source.declarationList.declarations)
        .map(({initializer}) => initializer.elements.map((type) => ts.factory.createLiteralTypeNode(ts.isNumericLiteral(type) ? ts.factory.createNumericLiteral(type.text) : ts.factory.createStringLiteral(type.text))))
        .flatMap((types, _, declarations) => declarations.length > 1 ? ts.factory.createUnionTypeNode(types) : types)
);

/**
 * Generate a function type from a JSDoc callback tag
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.JSDocCallbackTag} node - the callback tag node
 * @param {ts.Node} source - original node associated with the callback tag
 * @returns {ts.FunctionTypeNode} function type declaration for the callback tag
 */
const generateCallbackType = (checker, node, source) => ts.factory.createFunctionTypeNode(
    node.typeExpression.typeParameters?.length ? generateTypeParameterDeclarations(checker, resolveNodeLocals(node.parent)) : undefined,
    node.typeExpression.parameters?.map((node) => ts.factory.createParameterDeclaration(
        undefined, undefined, node.name,
        isOptionalType(node) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : node.questionToken,
        node.type ?? resolveActualType(checker, node.typeExpression?.type ?? node?.type ?? node),
        undefined
    )),
    resolveActualType(checker, node.typeExpression.type, source?.modifiers?.some(({kind}) => kind === ts.SyntaxKind.AsyncKeyword))
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
    ts.isJSDocEnumTag(node) ? generateEnumType(node.typeExpression, source) :
    ts.isJSDocCallbackTag(node) ? generateCallbackType(checker, node, source) :
    undefined
);

/**
 * Generate annotation and declarations for various types of class member
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.Node} node - the class member to annotate and declare
 * @param {Map<String, NamespaceMember>} namespaces - where to source inherited declaration details from
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
 * Generate heritage clauses for a class, using both explicit clauses and JSDoc heritage clause tags
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.ClassDeclaration} node - the class to generate heritage clauses for
 * @param {Boolean} [isInterface=false] - whether the heritage clauses are being generated for an interface declaration
 * @returns {[ts.HeritageClause,ts.HeritageClause]} extends and implements heritage clauses for the given class
 */
const generateClassHeritageClauses = (checker, node, isInterface = false) => ([
    ts.factory.createHeritageClause(
        ts.SyntaxKind.ExtendsKeyword, Array.from(new Map([
            // Make sure the type being extended is something that TypeScript won't complain about!
            ...(node.heritageClauses?.find(isExtendsClause)?.types ?? []).flatMap((node) => ((isConstructableType(checker, node) ^ isInterface) ? node : [])),
            ...ts.getAllJSDocTags(node, isJSDocExtendsTag).map((tag) => tag.class)
        ].map((type) => ([ts.isIdentifier(type.expression) ? type.expression.escapedText : type.expression.name?.escapedText, type]))).values())
    ),
    ts.factory.createHeritageClause(
        ts.SyntaxKind.ImplementsKeyword, ts.getAllJSDocTags(node, ts.isJSDocImplementsTag).map((tag) => tag.class)
    )
]);

/**
 * Generate an interface declaration for a class that extends a type that is not constructable
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.ClassDeclaration} node - the class to generate interface declaration for
 * @returns {ts.InterfaceDeclaration[]} the generated interface declaration
 */
const generateInterfaceDeclaration = (checker, node) => (node.heritageClauses?.find(isExtendsClause)?.types?.some((node) => !isConstructableType(checker, node)) ? [
    ts.factory.createInterfaceDeclaration(
        node.modifiers.filter(({kind}) => kind !== ts.SyntaxKind.DefaultKeyword), node.name,
        generateTypeParameterDeclarations(checker, resolveNodeLocals(node)),
        generateClassHeritageClauses(checker, node, true).filter(({types}) => types?.length)
    )
] : []);

/**
 * Generate a class declaration for a given class, including a possible interface declaration
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {ts.ClassDeclaration} node - the class to generate class declaration for
 * @param {MemberType} type - whether the given class is marked as a namespace or a plain class
 * @param {Map<string, any>} namespaces - where to source inherited declaration details from
 * @returns {(ts.InterfaceDeclaration|ts.ClassDeclaration)[]} the generated class declaration
 */
const generateClassDeclaration = (checker, node, type, namespaces) => (filterMembers(type, node.members).length ? [
    ...generateInterfaceDeclaration(checker, node),
    ts.factory.createClassDeclaration(
        node.modifiers.filter(({kind}) => kind !== ts.SyntaxKind.DefaultKeyword), node.name,
        generateTypeParameterDeclarations(checker, resolveNodeLocals(node)),
        generateClassHeritageClauses(checker, node).filter(({types}) => types?.length),
        ts.factory.createNodeArray([
            ...filterMembers(type, node.members).flatMap(node => generateMemberDeclaration(checker, node, namespaces))
        ])
    )
] : []);

/**
 * Generate a module declaration with the given contents
 * @param {ts.StringLiteral|ts.Identifier} name - string literal identifier for this module declaration
 * @param {ts.SyntaxKind.DeclareKeyword|ts.SyntaxKind.ExportKeyword} modifier - whether the declaration is a top-level module declaration or a nested namespace export
 * @param {ts.Node[]} nodes - contents of the module declaration
 * @returns {ts.ModuleDeclaration} the generated module declaration
 */
const generateModuleDeclaration = (name, modifier, nodes) => ts.factory.createModuleDeclaration(
    [ts.factory.createToken(modifier)], name, ts.factory.createModuleBlock(nodes),
    modifier === ts.SyntaxKind.ExportKeyword ? ts.NodeFlags.Namespace : undefined
);

/**
 * The namespace-containing tag name for a namespace member
 * @typedef {"namespace"|"alias"} MemberType
 */

/**
 * Details of a namespace member declaration
 * @typedef {Object} NamespaceMember
 * @prop {MemberType} [type] - name of the namespace-containing tag of the member
 * @prop {ts.ClassDeclaration} node - the declaration-containing node of the member
 * @prop {Map<String, NamespaceMember>} members - any resolved children of the member
 * @prop {ts.Node} [source] - the original node the member was found on
 */

/**
 * Recursively generate module and namespace declarations from a given set of structured definitions
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {Map<String, NamespaceMember>} members - any namespaces or type definitions that should be included in this namespace/module
 * @param {Map<String, NamespaceMember>} [namespaces=members] - the top-level set of structured definitions for sourcing inheritance
 * @returns {ts.ModuleDeclaration} module or namespace declaration with annotation and nested declarations
 */
const generateNamespaceDeclarations = (checker, members, namespaces = members) => Array.from(members.entries(), ([name, {type, node, members, source}]) => ([
    ...(!!type ? [
        // Generate an annotated class declaration, and recurse into any namespaced member declarations
        ...generateClassDeclaration(checker, node, type, namespaces),
        ...(members?.size ? [generateModuleDeclaration(ts.factory.createIdentifier(name), ts.SyntaxKind.ExportKeyword, generateNamespaceDeclarations(checker, members, namespaces))] : [])
    ] : node ? [
        // Annotate and generate any namespace member declarations
        ...(ts.isJSDocCallbackTag(node) ? annotateFunction(node) : annotateProp(node.parent)),
        ts.factory.createTypeAliasDeclaration(
            node.parent.tags?.some(ts.isJSDocPrivateTag) ? [] : [ts.factory.createToken(ts.SyntaxKind.ExportKeyword)],
            ts.factory.createIdentifier(name),
            generateTypeParameterDeclarations(checker, node.locals),
            generateTypeDeclaration(checker, node, source)
        )
    ] : [])
])).flat();

/**
 * External modules to be imported in the primary module declaration
 * @typedef {Object} ModuleImport
 * @prop {Set<String>} names - what the external modules should be imported as
 * @prop {Set<String>} bindings - any directly imported members of the external module
 */

/**
 * Generate import declarations for external modules
 * @param {Map<String, ModuleImport>} imports - external modules that are imported
 * @returns {ts.ImportDeclaration[]} import declarations for external modules
 */
const generateModuleImports = (imports) => Array.from(imports?.entries() ?? []).flatMap(([name, {names, bindings}]) => Array.from(names.values(), (binding, index) => ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(false, ts.factory.createIdentifier(binding), index > 0 || !bindings.size ? undefined : ts.factory.createNamedImports(
        Array.from(bindings.values(), (binding) => binding.split(",")).map(([k, v]) => ts.factory.createImportSpecifier(
            false, v && ts.factory.createIdentifier(k), ts.factory.createIdentifier(v ?? k)
        ))
    )),
    ts.factory.createStringLiteral(name),
    undefined
)));

/**
 * Generate exports for a module declaration
 * @param {ts.Identifier|ts.QualifiedName} defaultExport - identifier for the default export of the module declaration
 * @param {Map<String, NamespaceMember>} [members] - any nested namespaces that also need to be exported
 * @param {Map<String, ts.ExportDeclaration>} [exports] - any external modules that are re-exported
 * @returns {ts.Node[]} exports statements for the primary module declaration
 */
const generateModuleExports = (defaultExport, members, exports) => ([
    ...Array.from(exports?.values() ?? []),
    ...(members instanceof Map ? [
        // Create import equals aliases from each namespace member...
        ...Array.from(members.keys(), ts.factory.createIdentifier)
            .map((name) => ts.factory.createImportEqualsDeclaration(undefined, false, name, ts.factory.createQualifiedName(defaultExport, name))),
        // ...then, if there were any namespace members, export them!
        ...(members.size ? [ts.factory.createExportDeclaration(
            undefined, false, ts.factory.createNamedExports(Array.from(members.keys(), (name) => ts.factory.createExportSpecifier(false, undefined, ts.factory.createIdentifier(name))))
        )] : []),
        // Create the module's default export
        ts.factory.createExportDefault(!ts.isQualifiedName(defaultExport) ? defaultExport : ts.factory.createPropertyAccessExpression(defaultExport.left, defaultExport.right))
    ] : [])
]);

/**
 * Create a TypeScript source file and generate module declarations
 * @param {ts.TypeChecker} checker - the TypeScript program's type checker
 * @param {Object} content - details of what should be included in the source file
 * @param {String} content.moduleName - name of the primary module declaration included in this source file
 * @param {String} content.defaultExport - name of the primary module's primary export included in this source file
 * @param {Map<String, ModuleImport>} [content.imports] - any externally declared modules imported in this source file
 * @param {Map<string, ts.ExportDeclaration>} [content.exports] - any externally declared modules that are re-exported in this source file
 * @param {Map<String, String>} [content.modules] - names of modules to generate alias declarations for
 * @param {Map<String, NamespaceMember>} content.namespaces - contents of the primary module to generate declarations for
 * @returns {ts.SourceFile} the generated source file including all requested declarations
 */
export const generateDeclarationFile = (checker, {moduleName, defaultExport, imports, exports, modules, namespaces}) => ts.factory.createSourceFile(ts.factory.createNodeArray([
    ...Array.from(modules?.entries() ?? []).filter(([name]) => name !== moduleName).map(([name, namespace]) => generateModuleDeclaration(
        ts.factory.createStringLiteral(name), ts.SyntaxKind.DeclareKeyword, [
            ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, ts.factory.createIdentifier(defaultExport)), ts.factory.createStringLiteral(moduleName)),
            ...generateModuleExports(generateQualifiedName(namespace), findNamespaces(namespace, namespaces)?.members)
        ]
    )),
    generateModuleDeclaration(ts.factory.createStringLiteral(moduleName), ts.SyntaxKind.DeclareKeyword, [
        ...generateModuleImports(imports),
        ...generateModuleExports(ts.factory.createIdentifier(defaultExport), namespaces.get(defaultExport)?.members, exports),
        ...generateNamespaceDeclarations(checker, namespaces)
    ])
]));
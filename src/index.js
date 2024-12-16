import ts from "typescript";
import {findNamespaces, resolveImplicitTypeDefs} from "./lib/parse.js";
import {generateNamespaceDeclarations} from "./lib/generate.js";

export default function ostensiblyTyped(config = {}) {
    const {moduleName, defaultExport, entryFiles, sourceFiles = new Map()} = config;
    const compilerOptions = {...(config?.compilerOptions ?? {}), target: ts.ScriptTarget.Latest, allowJs: true};
    const readFile = (fileName) => (fileName.endsWith(ts.Extension.Js) ? ((!Array.isArray(sourceFiles) && sourceFiles.get(fileName)) || ts.sys.readFile(fileName))?.replaceAll(/({.*?)([~#])(.*?})/gm, "$1.$3") : ts.sys.readFile(fileName));
    const host = Object.assign(ts.createCompilerHost(compilerOptions), {readFile});
    const program = ts.createProgram(Array.isArray(entryFiles) ? entryFiles : [...sourceFiles.keys()], compilerOptions, host);
    const checker = program.getTypeChecker();
    const namespaces = new Map();
    const modules = new Map();
    
    for (let sourceFile of program.getSourceFiles()) {
        if (!sourceFile.isDeclarationFile) ts.forEachChild(sourceFile, function visitor(node) {
            if (ts.isClassDeclaration(node)) {
                findNamespaces(node, namespaces, ["namespace", "alias"], ({type, node}, existing = {}) => ({type, node, ...existing, source: node}));
                findNamespaces(node, modules, ["module"], ({node}) => ts.getAllJSDocTags(node, ({tagName: {escapedText} = {}}) => escapedText === "namespace").shift()?.comment);
                
                if (node.name.escapedText === defaultExport && !namespaces.has(defaultExport)) {
                    namespaces.set(defaultExport, {type: "alias", node, members: new Map()});
                }
            }
            
            resolveImplicitTypeDefs(checker, node, namespaces);
            ts.forEachChild(node, visitor);
        });
    }
    
    return ts.createPrinter({removeComments: false}).printFile(
        ts.factory.createSourceFile(ts.factory.createNodeArray([
            ...Array.from(modules.entries()).filter(([name]) => name !== moduleName).map(([name, namespace]) => ts.factory.createModuleDeclaration(
                [ts.factory.createToken(ts.SyntaxKind.DeclareKeyword)], ts.factory.createStringLiteral(name),
                ts.factory.createModuleBlock([
                    ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, ts.factory.createIdentifier(defaultExport)), ts.factory.createStringLiteral(moduleName)),
                    ts.factory.createExportAssignment(undefined, true, ts.factory.createPropertyAccessExpression(...namespace.split(".").map(ts.factory.createIdentifier)))
                ])
            )),
            generateNamespaceDeclarations(checker, ts.factory.createStringLiteral(moduleName), ts.SyntaxKind.DeclareKeyword, namespaces)
        ]))
    )
}
import ts from "typescript";
import {findNamespaces, resolveImplicitTypeDefs} from "./lib/parse.js";
import {generateDeclarationFile} from "./lib/generate.js";

/**
 * Generate a TypeScript type definition file for a JavaScript library using JSDoc type annotations
 * @param {Object} [config={}] - configuration and source file contents to generate type definitions for
 * @param {String} config.moduleName - name of the module primarily being declared for the library
 * @param {String} config.defaultExport - name of the default export of the primary module declaration
 * @param {Map<String,String>} [config.sourceFiles] - preloaded source files to include in the TypeScript program
 * @param {String[]} [config.entryFiles] - file names of library entry files
 * @param {String[]} [config.externalModules] - any external modules used in type annotations
 * @param {Object} [config.compilerOptions] - any additional options to pass through to the TypeScript compiler
 * @returns {String} the generated type definition file
 */
export default function ostensiblyTyped({moduleName, defaultExport, entryFiles, sourceFiles = new Map(), externalModules = [], ...config} = {}) {
    const compilerOptions = {...(config?.compilerOptions ?? {}), target: ts.ScriptTarget.Latest, allowJs: true};
    const readFile = (fileName) => (fileName.endsWith(ts.Extension.Js) ? (sourceFiles.has(fileName) ? sourceFiles.get(fileName) : ts.sys.readFile(fileName))?.replaceAll(/({.*?)([~#])(.*?})/gm, "$1.$3") : ts.sys.readFile(fileName));
    const host = Object.assign(ts.createCompilerHost(compilerOptions), {readFile});
    const program = ts.createProgram(Array.isArray(entryFiles) ? entryFiles : [...sourceFiles.keys()], compilerOptions, host);
    const checker = program.getTypeChecker();
    const namespaces = new Map();
    const modules = new Map();
    const imports = new Map();
    const exports = new Set();
    
    // Go through all loaded source files to build the declaration file
    for (let sourceFile of program.getSourceFiles()) {
        if (!sourceFile.isDeclarationFile) ts.forEachChild(sourceFile, function visitor(node) {
            // Handle types imported from external modules
            if (ts.isImportDeclaration(node)) {
                const name = node.moduleSpecifier.text;
                
                if (externalModules.includes(name)) {
                    const {importClause} = node;
                    const {names, bindings} = (imports.has(name) ? imports : imports.set(name, {names: new Set(), bindings: new Set()})).get(name);
                    
                    // Save direct and named import bindings
                    if (importClause.name) names.add(importClause.name.escapedText);
                    for (let {propertyName, name} of node.importClause.namedBindings?.elements ?? []) {
                        bindings.add([...new Set([propertyName?.escapedText, name?.escapedText].filter(v => v))].join(","));
                    }
                }
            }
            
            // Handle re-exported external modules
            if (ts.isExportDeclaration(node) && entryFiles.includes(sourceFile.fileName)) {
                const declarations = node.exportClause.elements
                    .flatMap(({name}) => sourceFile.locals.get(name.escapedText)?.declarations)
                    .filter(ts.isImportClause).map(({parent: {moduleSpecifier: {text}}}) => text);
                
                if (declarations.some((name) => externalModules.includes(name))) exports.add(node);
            }
            
            // Handle class declarations, building structure of namespace declarations
            if (ts.isClassDeclaration(node)) {
                findNamespaces(node, namespaces, ["namespace", "alias"], ({type, node}, existing = {}) => ({type, node, ...existing, source: node}));
                findNamespaces(node, modules, ["module"], ({node}) => ts.getAllJSDocTags(node, ({tagName: {escapedText} = {}}) => escapedText === "namespace").shift()?.comment);
                
                if (node.name.escapedText === defaultExport && !namespaces.has(defaultExport)) {
                    namespaces.set(defaultExport, {type: "alias", node, members: new Map()});
                }
            }
            
            // Find any annotations that look like types, then dig deeper!
            resolveImplicitTypeDefs(checker, node, namespaces);
            ts.forEachChild(node, visitor);
        });
    }
    
    // Generate the declaration file and "print" it, returning the contents
    return ts.createPrinter({removeComments: false}).printFile(generateDeclarationFile(checker, {moduleName, defaultExport, imports, exports, modules, namespaces}));
}
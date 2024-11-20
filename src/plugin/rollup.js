import docsToDefinitions from "../index.js";

export function generateDeclarations({moduleName, defaultExport, compilerOptions}) {
    const sourceFiles = new Map();
    const entryFiles = [];
    
    return {
        name: "dtsGen",
        api: {
            getRootFileNames: () => ([...sourceFiles.keys()].sort((a, b) => a.localeCompare(b, undefined, {numeric: true})))
        },
        buildStart() {
            sourceFiles.clear();
        },
        moduleParsed(info) {
            if (!info.isExternal) sourceFiles.set(info.id, info.code);
            if (info.isEntry) entryFiles.push(info.id);
        },
        buildEnd() {
            this.emitFile({
                type: "asset",
                fileName: `${moduleName}.d.ts`,
                source: docsToDefinitions({moduleName, defaultExport, sourceFiles, entryFiles, compilerOptions})
            });
        }
    };
}

export function filterGeneratedBundle({emitDeclarationOnly = false, formats = ["es", "esm"]}) {
    let dtsGen;
    
    return {
        renderStart(_, {plugins}) {
            dtsGen = plugins.find(({name}) => name === "dtsGen")?.api;
        },
        generateBundle({format}, bundle) {
            if (formats.includes(format)) {
                for (let key in bundle) {
                    if (key.endsWith(".d.ts") && bundle[key].type === "asset") bundle[key].originalFileNames.push(...(dtsGen?.getRootFileNames() ?? []));
                    if (emitDeclarationOnly ? !(bundle[key].type === "asset" && key.endsWith(".d.ts")) : (key.endsWith(".d.ts") && bundle[key].type === "asset")) {
                        delete bundle[key];
                    }
                }
            }
        }
    };
}
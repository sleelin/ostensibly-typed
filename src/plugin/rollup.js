import docsToDefinitions from "../index.js";

/**
 * @typedef {Object} OstensiblyTypedGeneratorOptions
 * @prop {String} moduleName - name of the module that is the library's primary declaration
 * @prop {String} defaultExport - name of the default export of the declared module
 * @prop {import("typescript").CompilerOptions} compilerOptions - config to pass through to the TypeScript compiler
 */

/**
 * @typedef {Object} OstensiblyTypedGeneratorAPI
 * @prop {() => String[]} getRootFileNames
 */

/**
 * Create an OstensiblyTyped declaration generator input plugin
 * @type {import("rollup").PluginImpl<OstensiblyTypedGeneratorOptions, OstensiblyTypedGeneratorAPI>}
 */
export function generateDeclarations({moduleName, defaultExport, compilerOptions} = {}) {
    const saneOptions = !!(moduleName && defaultExport);
    const sourceFiles = new Map();
    let entryFiles = [];
    
    return {
        name: "OstensiblyTyped",
        api: {
            // Expose method of retrieving sorted root file names
            getRootFileNames: () => ([...sourceFiles.keys()].sort((a, b) => a.localeCompare(b, undefined, {numeric: true})))
        },
        buildStart() {
            // Empty out all previous source and entry files
            sourceFiles.clear();
            entryFiles = [];
            
            if (!moduleName) this.warn("Generator disabled, missing required 'moduleName' config property");
            if (!defaultExport) this.warn("Generator disabled, missing required 'defaultExport' config property");
        },
        moduleParsed(info) {
            if (saneOptions) {
                // Store source and entry files for generator
                if (!info.isExternal) sourceFiles.set(info.id, info.code);
                if (info.isEntry) entryFiles.push(info.id);
            }
        },
        buildEnd() {
            // Emit the declaration file as an asset, if options were sane
            if (saneOptions) this.emitFile({
                type: "asset",
                fileName: `${moduleName}.d.ts`,
                // Generate the declaration file!
                source: docsToDefinitions({moduleName, defaultExport, sourceFiles, entryFiles, compilerOptions})
            });
        }
    };
}

/**
 * Create an OstensiblyTyped declaration filtering output plugin
 * @param {Object} [options={}] - OstensiblyTyped output plugin options
 * @param {Boolean} [options.emitDeclarationOnly=false] - whether to exclusively emit the generated declaration file on write
 * @param {String[]} [options.formats=['es', 'esm']] - which output formats to include generated declaration files in 
 * @returns {import("rollup").OutputPlugin} the OstensiblyTyped rollup output plugin
 */
export function filterGeneratedBundle({emitDeclarationOnly = false, formats = ["es", "esm"]} = {}) {
    let dtsGen;
    
    return {
        name: "OstensiblyTyped",
        renderStart(_, {plugins}) {
            // Find the OstensiblyTyped generator plugin so we can retrieve root file names
            dtsGen = plugins.find(({name}) => name === "OstensiblyTyped")?.api;
        },
        generateBundle({format}, bundle) {
            for (let key in bundle) {
                // See if this was the generated declaration file asset
                const isGeneratedAsset = bundle[key].type === "asset" && key.endsWith(".d.ts");
                
                // If so, attach root file names
                if (isGeneratedAsset) bundle[key].originalFileNames.push(...(dtsGen?.getRootFileNames() ?? []));
                // Either filter out all non-declaration files from the bundle, or filter the declaration if wrong bundle format
                if (emitDeclarationOnly ? !isGeneratedAsset : isGeneratedAsset && !formats.includes(format))
                    delete bundle[key];
            }
        }
    };
}
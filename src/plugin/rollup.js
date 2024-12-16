import {basename, dirname} from "path";
import docsToDefinitions from "../index.js";

/**
 * @typedef {Object} OstensiblyTypedGeneratorOptions
 * @prop {String} moduleName - name of the module that is the library's primary declaration
 * @prop {String} defaultExport - name of the default export of the declared module
 * @prop {import("typescript").CompilerOptions} compilerOptions - config to pass through to the TypeScript compiler
 * @prop {String} [assetName=moduleName] - name of the emitted asset file that is the library's primary declaration
 */

/**
 * @typedef {Object} OstensiblyTypedGeneratorAPI
 * @prop {() => String[]} getRootFileNames
 */

/**
 * Create an OstensiblyTyped declaration generator input plugin
 * @type {import("rollup").PluginImpl<OstensiblyTypedGeneratorOptions, OstensiblyTypedGeneratorAPI>}
 */
export function generateDeclarations({moduleName, defaultExport, compilerOptions, assetName = moduleName} = {}) {
    const saneOptions = !!(moduleName && defaultExport);
    const sourceFiles = new Map();
    let entryFiles,
        isExternal,
        externalModules,
        assetReference;
    
    return {
        name: "OstensiblyTyped",
        api: {
            // Expose method of retrieving sorted root file names
            getRootFileNames: () => ([...sourceFiles.keys()].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))),
            // Expose method of retrieving generated asset reference
            getAssetReference: () => assetReference
        },
        buildStart({external}) {
            // Empty out all previous source and entry files
            sourceFiles.clear();
            entryFiles = [];
            externalModules = [];
            isExternal = external;
            
            if (!moduleName) this.warn("Generator disabled, missing required 'moduleName' config property");
            if (!defaultExport) this.warn("Generator disabled, missing required 'defaultExport' config property");
        },
        moduleParsed(info) {
            if (saneOptions) {
                // Store source and entry files for generator
                if (!info.isExternal) sourceFiles.set(info.id, info.code);
                if (info.isEntry) {
                    entryFiles.push(info.id);
                    externalModules.push(...info.importedIds.filter(isExternal));
                }
            }
        },
        buildEnd() {
            // Emit the declaration file as an asset, if options were sane
            if (saneOptions) assetReference = this.emitFile({
                type: "asset",
                fileName: `${assetName}.d.ts`,
                // Generate the declaration file!
                source: docsToDefinitions({moduleName, defaultExport, sourceFiles, entryFiles, compilerOptions, externalModules})
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
    let dtsGen, outFileName;
    
    return {
        name: "OstensiblyTyped",
        outputOptions({file, dir, ...options}) {
            // If "file" option was set, grab the file name...
            outFileName = file ? basename(file) : undefined;
            // ...but change it to "dir" so Rollup doesn't complain
            return {dir: dir ?? dirname(file), ...options};
        },
        renderStart(_, {plugins}) {
            // Find the OstensiblyTyped generator plugin so we can retrieve root file names
            dtsGen = plugins.find(({name}) => name === "OstensiblyTyped")?.api;
        },
        generateBundle({format}, bundle) {
            const generatedAssetName = this.getFileName(dtsGen.getAssetReference());
            
            // If "file" points to a .d.ts file, we implicitly only want the declaration file
            if (outFileName?.endsWith(".d.ts")) emitDeclarationOnly = true;
            
            for (let key in bundle) {
                // See if this was the generated declaration file asset
                const isGeneratedAsset = bundle[key].type === "asset" && key === generatedAssetName;
                
                // If so, attach root file names
                if (isGeneratedAsset) bundle[key].originalFileNames.push(...(dtsGen?.getRootFileNames() ?? []));
                // Either filter out all non-declaration files from the bundle, or filter the declaration if wrong bundle format
                if (emitDeclarationOnly ? !isGeneratedAsset : isGeneratedAsset && !formats.includes(format))
                    delete bundle[key];
            }
            
            // If "file" was given as an input option, and the name doesn't match expected name...
            if (!!outFileName && outFileName !== generatedAssetName) {
                // ...rename it!
                bundle[outFileName] = Object.assign(bundle[generatedAssetName], {fileName: outFileName});
                delete bundle[generatedAssetName];
            }
        }
    };
}
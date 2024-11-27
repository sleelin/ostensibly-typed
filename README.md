# OstensiblyTyped

Generate type declarations for JavaScript libraries at build time, from JSDoc type annotations.

##### Requirements:
* TypeScript v5.6+ as a peer dependency

#### What?

A tool for JavaScript library developers to generate TypeScript type declaration files using their existing JSDoc type annotations.

The name "OstensiblyTyped" is a play on the name of the [DefinitelyTyped](https://definitelytyped.org/) project: there's no built-in type checking in the JavaScript runtime ([for now?](https://github.com/tc39/proposal-type-annotations)),
but almost all modern development environments have the ability to detect and check types using JSDoc type annotations.
In these environments, one could say your library is already _ostensibly typed_.

#### Why?

If you've ever followed [this guide](https://www.typescriptlang.org/docs/handbook/declaration-files/dts-from-js.html) from the TypeScript Handbook, you probably have a good idea why.
While it's a good start when you're working with a few simple JavaScript files, it falls over pretty quickly if you're following it for something more complex.
For larger libraries, the type declarations produced by the TypeScript compiler are often incomplete, incorrect, or just end up falling back to the _any_ type, which defeats the purpose of adding type declarations in the first place.

You could hand-write the TypeScript declarations you include with your library, but that means maintaining types both there and in your existing annotations - that's where OstensiblyTyped comes in!

#### How?

By using the TypeScript compiler to scour your JavaScript files for JSDoc type annotations, then manually building a new declaration file, threading type annotations in along the way.
The generated declaration file includes types written in JSDoc @typedef and @callback tags, and accounts for module namespaces in any annotated type names. 

## Installation

Through your favourite NodeJS package manager:

```
$ npm install -D ostensibly-typed
```

## Usage

OstensiblyTyped can be called directly during your build process, or used via the included RollupJS plugin.

#### Standalone Usage

Somewhere in your build process:

```js
import ostensiblyTyped from "ostensibly-typed";
import {promises as fs} from "fs";

await fs.writeFile("./dest/some-library.d.ts", ostensiblyTyped({
    moduleName: "some-library", 
    defaultExport: "SomeLibrary",
    entryFiles: ["./src/some-library.js"]
}));
```

The supplied method takes a single configuration object with the following properties:
* `moduleName`: the name of the top-level module being declared
* `defaultExport`: name of your library's default export
* `entryFiles`: array of filename strings specifying which files the TypeScript compiler should load
* (Optional) `sourceFiles`: a JavaScript `Map` with entry file names as keys, and source file code as values
  * These values will be used in-lieu of TypeScript's built-in file loader
* (Optional) `compilerOptions`: any additional options to pass to the TypeScript compiler
  * In order to function correctly, the `allowJs` option will always be set to `true`

#### With the Plugin

In your Rollup config:

```js
// rollup.config.js
import {generateDeclarations} from "ostensibly-typed/plugin-rollup";

export default {
    input: "./src/some-library.js",
    output: {
        dir: "./dest",
        format: "esm"
    },
    plugins: [
        generateDeclarations({moduleName: "some-library", defaultExport: "SomeLibrary"})
    ]
};
```

Or as a Vite plugin:

```js
// vite.config.js
import {defineConfig} from "vite";
import {generateDeclarations} from "ostensibly-typed/plugin-rollup";

export default defineConfig({
    base: "./",
    build: {
        lib: {
            formats: ["es"],
            entry: "./src/some-library.js"
        }
    },
    plugins: [
        generateDeclarations({moduleName: "some-library", defaultExport: "SomeLibrary"})
    ]
});
```

The `generateDeclarations` method takes a single configuration object with the following properties:
* `moduleName`: the name of the top-level module being declared
  * This will also be used as the file name for the emitted declaration file asset
* `defaultExport`: name of your library's default export
* (Optional) `compilerOptions`: any additional options to pass to the TypeScript compiler
  * In order to function correctly, the `allowJs` option will always be set to `true`

### Supported Tags

The following JSDoc tags are currently handled when generating the declaration file:
* `@module`: identifies top-level module declarations that can be imported by library consumers
* `@namespace`: identifies classes that should also be treated as containing namespaces for declaration merging
* `@alias`: used to determine which namespace a given class should be declared under
* `@enum`: will be transformed into a TypeScript literal type declaration under the namespace specified by the name portion of the tag
* `@typedef`: will be transformed into an actual TypeScript type declaration under the namespace specified by the name portion of the tag
* `@callback`: will be transformed into a TypeScript function declaration under the namespace specified by the name portion of the tag
* `@param`/`@parameter`: used to specify the type for function or class method arguments
* `@prop`/`@property`: used to specify class or variable properties that are not explicitly documented at assignment
* `@template`: will be transformed into "type parameters" for annotated classes, methods, and callbacks
* `@typeParam`: used to specify additional type parameters for annotated methods and callbacks
* `@abstract`: used to specify that a given class method should be treated as an implicit type declaration
* `@private`: used to prevent type declarations generated for a given annotation from being exported
* `@internal`: used to prevent generation of type declarations for a given annotation
* `@overload`: will be transformed into an extra call signature for a function or class method
* `@throws`: used to specify that the return type for a callback or method should be "never"
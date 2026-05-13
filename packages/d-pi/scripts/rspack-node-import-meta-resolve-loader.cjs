"use strict";

const SEARCH = "import.meta.resolve(specifier)";
const REPLACEMENT =
	'module.require("node:url").pathToFileURL(module.require("node:module").createRequire(module.filename).resolve(specifier)).href';

module.exports = function nodeImportMetaResolveLoader(source) {
	if (!source.includes(SEARCH)) {
		return source;
	}
	return source.split(SEARCH).join(REPLACEMENT);
};

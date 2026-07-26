// Syntax highlighting for the file viewer's read-only view. Client-only and loaded
// lazily (`await import('../lib/highlight')`) so none of it — core or grammars — is
// downloaded until someone actually opens a code file. It never runs on the Worker:
// highlighting is cosmetic, and burning request CPU on it would be a poor trade.
//
// refractor rather than Prism/highlight.js directly, because it hands back a hast tree
// instead of an HTML string. That keeps the same rule the rest of this codebase follows
// (see markdown.ts): nothing reaches the page through {@html} unless we built every tag
// in it ourselves. The panel renders the tree with a Svelte snippet, so Svelte's normal
// text interpolation does the escaping and there's no sanitizer to get wrong.

import { refractor } from 'refractor/core';
import type { RootContent } from 'hast';

// One grammar per language `file-kind.ts`'s languageFor() can return. Static imports, so
// this whole module is a single lazy chunk — Vite can't split a bare specifier behind a
// runtime variable, and 40-odd separate round trips would be worse than one cached chunk
// anyway. Languages that pull in others (tsx -> jsx + typescript) register their own
// dependencies, so only the top-level ones are listed.
import arduino from 'refractor/arduino';
import bash from 'refractor/bash';
import batch from 'refractor/batch';
import c from 'refractor/c';
import cmake from 'refractor/cmake';
import cpp from 'refractor/cpp';
import csharp from 'refractor/csharp';
import css from 'refractor/css';
import dart from 'refractor/dart';
import diff from 'refractor/diff';
import docker from 'refractor/docker';
import fortran from 'refractor/fortran';
import gcode from 'refractor/gcode';
import go from 'refractor/go';
import groovy from 'refractor/groovy';
import ini from 'refractor/ini';
import java from 'refractor/java';
import javascript from 'refractor/javascript';
import json from 'refractor/json';
import jsx from 'refractor/jsx';
import julia from 'refractor/julia';
import kotlin from 'refractor/kotlin';
import latex from 'refractor/latex';
import less from 'refractor/less';
import lua from 'refractor/lua';
import makefile from 'refractor/makefile';
import markdown from 'refractor/markdown';
import markup from 'refractor/markup';
import matlab from 'refractor/matlab';
import perl from 'refractor/perl';
import php from 'refractor/php';
import powershell from 'refractor/powershell';
import properties from 'refractor/properties';
import python from 'refractor/python';
import r from 'refractor/r';
import ruby from 'refractor/ruby';
import rust from 'refractor/rust';
import sass from 'refractor/sass';
import scss from 'refractor/scss';
import sql from 'refractor/sql';
import swift from 'refractor/swift';
import toml from 'refractor/toml';
import tsx from 'refractor/tsx';
import typescript from 'refractor/typescript';
import verilog from 'refractor/verilog';
import vhdl from 'refractor/vhdl';
import yaml from 'refractor/yaml';

for (const syntax of [
	arduino, bash, batch, c, cmake, cpp, csharp, css, dart, diff, docker, fortran,
	gcode, go, groovy, ini, java, javascript, json, jsx, julia, kotlin, latex, less,
	lua, makefile, markdown, markup, matlab, perl, php, powershell, properties, python,
	r, ruby, rust, sass, scss, sql, swift, toml, tsx, typescript, verilog, vhdl, yaml,
]) {
	refractor.register(syntax);
}

export type { RootContent };

// The tokens for one chunk of source, or null when the language isn't one we registered
// — callers fall back to rendering the text plainly rather than treating it as an error.
export function highlightCode(code: string, language: string): RootContent[] | null {
	// The typeof check is not redundant with the signature: `language` traces back to a
	// filename extension and to the ```fence label in a user's Markdown, so it is only a
	// string by convention. refractor throws a TypeError rather than returning false for
	// a non-string, and `registered` sits outside the try below — the guard keeps a bad
	// value from depending on a caller's catch to stay harmless.
	if (typeof language !== 'string' || !refractor.registered(language)) return null;

	try {
		return refractor.highlight(code, language).children;
	} catch {
		// A grammar throwing on odd input shouldn't cost the user their preview.
		return null;
	}
}

function classNames(node: Extract<RootContent, { type: 'element' }>): string {
	const value = node.properties?.className;
	if (Array.isArray(value)) return value.join(' ');
	return typeof value === 'string' ? value : '';
}

// DOM equivalent of the panel's Svelte snippet, for the one place a snippet can't reach:
// fenced code blocks inside Markdown, which arrive through {@html} and so aren't part of
// any component template. Builds real nodes rather than an HTML string, for the same
// reason the tree exists at all.
export function hastToDom(nodes: RootContent[]): DocumentFragment {
	const fragment = document.createDocumentFragment();

	// appendChild rather than append throughout: the Workers types declare their own
	// global `Element` (HTMLRewriter's), which merges with the DOM one and leaves
	// `append` typed for that instead. appendChild isn't overloaded, so it stays honest.
	for (const node of nodes) {
		if (node.type === 'text') {
			fragment.appendChild(document.createTextNode(node.value));
		} else if (node.type === 'element') {
			const el = document.createElement('span');
			const className = classNames(node);
			if (className) el.className = className;
			el.appendChild(hastToDom(node.children));
			fragment.appendChild(el);
		}
	}

	return fragment;
}

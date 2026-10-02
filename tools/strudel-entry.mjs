// Entry point for the vendored Strudel bundle (vendor/strudel.bundle.js).
// Everything the site needs from Strudel and CodeMirror goes through here so that
// there is exactly one copy of @strudel/core and one copy of @codemirror/state.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as transpilerPkg from '@strudel/transpiler';
import * as draw from '@strudel/draw';
import * as webaudio from '@strudel/webaudio';
import * as superdough from 'superdough';
import * as soundfonts from '@strudel/soundfonts';
import * as codemirror from '@strudel/codemirror';

export { core, mini, tonal, transpilerPkg, draw, webaudio, superdough, soundfonts, codemirror };

export { EditorState, StateEffect, StateField, Compartment, RangeSetBuilder, Prec } from '@codemirror/state';
export { EditorView, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
export { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { parse } from 'acorn';

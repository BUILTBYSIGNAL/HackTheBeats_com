// The song analyser, bound to the parser that ships in the Strudel bundle.
import { parse } from '../vendor/strudel.bundle.js';
import { createAnalyzer } from './analyze-core.js';

export const analyze = createAnalyzer(parse);
export { sliderText, sliderReadout, applySliderValues, applySaved, shapeOf } from './analyze-core.js';

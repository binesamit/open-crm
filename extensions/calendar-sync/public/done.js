// SPDX-License-Identifier: AGPL-3.0-only
// The end of the Google consent, in the window it opened in: say how it went and close on success.
import { STRINGS } from './strings.js';

const status = document.body.dataset.status || 'error';
const lang = (navigator.language || 'he').startsWith('he') ? 'he' : 'en';
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
document.getElementById('msg').textContent = STRINGS[lang][`done_${status}`] ?? STRINGS[lang].error;
// The page that opened this window asks the server how it ended (a Bines page's opener policy leaves no opener).
if (status === 'ok') setTimeout(() => window.close(), 800);

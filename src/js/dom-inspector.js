/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

'use strict';

/******************************************************************************/
/******************************************************************************/

const svgRoot = document.querySelector('svg');

const quit = ( ) => {
    inspectorContentPort.postMessage({ what: 'quitInspector' });
    inspectorContentPort.close();
    inspectorContentPort.onmessage = inspectorContentPort.onmessageerror = null;
    inspectorContentPort = undefined;
    loggerPort.postMessage({ what: 'quitInspector' });
    loggerPort.close();
    loggerPort.onmessage = loggerPort.onmessageerror = null;
    loggerPort = undefined;
};

const onMessage = (msg, fromLogger) => {
    switch ( msg.what ) {
        case 'quitInspector': {
            quit();
            break;
        }
        case 'svgPaths': {
            const paths = svgRoot.children;
            paths[0].setAttribute('d', msg.paths[0]);
            paths[1].setAttribute('d', msg.paths[1]);
            paths[2].setAttribute('d', msg.paths[2]);
            paths[3].setAttribute('d', msg.paths[3]);
            break;
        }
        default:
            if ( typeof fromLogger !== 'boolean' ) { return; }
            if ( fromLogger ) {
                inspectorContentPort.postMessage(msg);
            } else {
                loggerPort.postMessage(msg);
            }
            break;
    }
};

// Wait for the content script to establish communication

let inspectorContentPort;

let loggerPort = new globalThis.BroadcastChannel('loggerInspector');
loggerPort.onmessage = ev => {
    const msg = ev.data || {};
    onMessage(msg, true);
};
loggerPort.onmessageerror = ( ) => {
    quit();
};

globalThis.addEventListener('message', ev => {
    const msg = ev.data || {};
    if ( msg.what !== 'startInspector' ) { return; }
    if ( Array.isArray(ev.ports) === false ) { return; }
    if ( ev.ports.length === 0 ) { return; }
    inspectorContentPort = ev.ports[0];
    inspectorContentPort.onmessage = ev => {
        const msg = ev.data || {};
        onMessage(msg, false);
    };
    inspectorContentPort.onmessageerror = ( ) => {
        quit();
    };
    inspectorContentPort.postMessage({ what: 'startInspector' });
}, { once: true });

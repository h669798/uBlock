/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2017-present Raymond Hill

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

/* globals browser */

'use strict';

/******************************************************************************/

import µb from './background.js';
import { onBroadcast } from './broadcast.js';
import { redirectEngine as reng } from './redirect-engine.js';
import { sessionFirewall } from './filtering-engines.js';
import { StaticExtFilteringHostnameDB } from './static-ext-filtering-db.js';

import {
    domainFromHostname,
    entityFromDomain,
    hostnameFromURI,
} from './uri-utils.js';

/******************************************************************************/

// Increment when internal representation changes
const VERSION = 1;

const duplicates = new Set();
const scriptletCache = new µb.MRUCache(32);

const scriptletDB = new StaticExtFilteringHostnameDB(1, VERSION);

let acceptedCount = 0;
let discardedCount = 0;

let isDevBuild;

const scriptletFilteringEngine = {
    get acceptedCount() {
        return acceptedCount;
    },
    get discardedCount() {
        return discardedCount;
    },
    getFilterCount() {
        return scriptletDB.size;
    },
};

const contentScriptRegisterer = new (class {
    constructor() {
        this.hostnameToDetails = new Map();
        if ( browser.contentScripts === undefined ) { return; }
        onBroadcast(msg => {
            if ( msg.what !== 'filteringBehaviorChanged' ) { return; }
            if ( msg.direction > 0 ) { return; }
            if ( msg.hostname ) { return this.flush(msg.hostname); }
            this.reset();
        });
    }
    register(hostname, code) {
        if ( browser.contentScripts === undefined ) { return false; }
        if ( hostname === '' ) { return false; }
        const details = this.hostnameToDetails.get(hostname);
        if ( details !== undefined ) {
            if ( code === details.code ) {
                return details.handle instanceof Promise === false;
            }
            details.handle.unregister();
            this.hostnameToDetails.delete(hostname);
        }
        const promise = browser.contentScripts.register({
            js: [ { code } ],
            allFrames: true,
            matches: [ `*://*.${hostname}/*` ],
            matchAboutBlank: true,
            runAt: 'document_start',
        }).then(handle => {
            this.hostnameToDetails.set(hostname, { handle, code });
        }).catch(( ) => {
            this.hostnameToDetails.delete(hostname);
        });
        this.hostnameToDetails.set(hostname, { handle: promise, code });
        return false;
    }
    unregister(hostname) {
        if ( this.hostnameToDetails.size === 0 ) { return; }
        const details = this.hostnameToDetails.get(hostname);
        if ( details === undefined ) { return; }
        this.hostnameToDetails.delete(hostname);
        this.unregisterHandle(details.handle);
    }
    flush(hostname) {
        if ( hostname === '*' ) { return this.reset(); }
        for ( const hn of this.hostnameToDetails.keys() ) {
            if ( hn.endsWith(hostname) === false ) { continue; }
            const pos = hn.length - hostname.length;
            if ( pos !== 0 && hn.charCodeAt(pos-1) !== 0x2E /* . */ ) { continue; }
            this.unregister(hn);
        }
    }
    reset() {
        if ( this.hostnameToDetails.size === 0 ) { return; }
        for ( const details of this.hostnameToDetails.values() ) {
            this.unregisterHandle(details.handle);
        }
        this.hostnameToDetails.clear();
    }
    unregisterHandle(handle) {
        if ( handle instanceof Promise ) {
            handle.then(handle => { handle.unregister(); });
        } else {
            handle.unregister();
        }
    }
})();

// Purpose of `contentscriptCode` below is too programmatically inject
// content script code which only purpose is to inject scriptlets. This
// essentially does the same as what uBO's declarative content script does,
// except that this allows to inject the scriptlets earlier than it is
// possible through the declarative content script.
//
// Declaratively:
//  1. Browser injects generic content script =>
//      2. Content script queries scriptlets =>
//          3. Main process sends scriptlets =>
//              4. Content script injects scriptlets
//
// Programmatically:
//  1. uBO injects specific scriptlets-aware content script =>
//      2. Content script injects scriptlets
//
// However currently this programmatic injection works well only on
// Chromium-based browsers, it does not work properly with Firefox. More
// investigations is needed to find out why this fails with Firefox.
// Consequently, the programmatic-injection code path is taken only with
// Chromium-based browsers.

const mainWorldInjector = (( ) => {
    const parts = [
        '(',
        function(injector, details) {
            if ( typeof self.uBO_scriptletsInjected === 'string' ) { return; }
            const doc = document;
            if ( doc.location === null ) { return; }
            const hostname = doc.location.hostname;
            if ( hostname !== '' && details.hostname !== hostname ) { return; }
            injector(doc, details);
            return 0;
        }.toString(),
        ')(',
            vAPI.scriptletsInjector, ', ',
            'json-slot',
        ');',
    ];
    return {
        parts,
        jsonSlot: parts.indexOf('json-slot'),
        assemble: function(hostname, scriptlets, filters) {
            this.parts[this.jsonSlot] = JSON.stringify({
                hostname,
                scriptlets,
                filters,
            });
            return this.parts.join('');
        },
    };
})();

const isolatedWorldInjector = (( ) => {
    const parts = [
        '(',
        function(details) {
            if ( self.uBO_isolatedScriptlets === 'done' ) { return; }
            const doc = document;
            if ( doc.location === null ) { return; }
            const hostname = doc.location.hostname;
            if ( hostname !== '' && details.hostname !== hostname ) { return; }
            const isolatedScriptlets = function(){};
            isolatedScriptlets();
            self.uBO_isolatedScriptlets = 'done';
            return 0;
        }.toString(),
        ')(',
            'json-slot',
        ');',
    ];
    return {
        parts,
        jsonSlot: parts.indexOf('json-slot'),
        assemble: function(hostname, scriptlets) {
            this.parts[this.jsonSlot] = JSON.stringify({ hostname });
            const code = this.parts.join('');
            // Manually substitute noop function with scriptlet wrapper
            // function, so as to not suffer instances of special
            // replacement characters `$`,`\` when using String.replace()
            // with scriptlet code.
            const match = /function\(\)\{\}/.exec(code);
            return code.slice(0, match.index) +
                scriptlets +
                code.slice(match.index + match[0].length);
        },
    };
})();

const normalizeRawFilter = function(parser, sourceIsTrusted = false) {
    const args = parser.getScriptletArgs();
    if ( args.length !== 0 ) {
        let token = `${args[0]}.js`;
        if ( reng.aliases.has(token) ) {
            token = reng.aliases.get(token);
        }
        if ( parser.isException() !== true ) {
            if ( sourceIsTrusted !== true ) {
                if ( reng.tokenRequiresTrust(token) ) { return; }
            }
        }
        args[0] = token.slice(0, -3);
    }
    return JSON.stringify(args);
};

const lookupScriptlet = function(rawToken, mainMap, isolatedMap) {
    if ( mainMap.has(rawToken) || isolatedMap.has(rawToken) ) { return; }
    const args = JSON.parse(rawToken);
    const token = `${args[0]}.js`;
    const details = reng.contentFromName(token, 'text/javascript');
    if ( details === undefined ) { return; }
    const targetWorldMap = details.world !== 'ISOLATED' ? mainMap : isolatedMap;
    const content = patchScriptlet(details.js, args.slice(1));
    const dependencies = details.dependencies || [];
    while ( dependencies.length !== 0 ) {
        const token = dependencies.shift();
        if ( targetWorldMap.has(token) ) { continue; }
        const details = reng.contentFromName(token, 'fn/javascript') ||
            reng.contentFromName(token, 'text/javascript');
        if ( details === undefined ) { continue; }
        targetWorldMap.set(token, details.js);
        if ( Array.isArray(details.dependencies) === false ) { continue; }
        dependencies.push(...details.dependencies);
    }
    targetWorldMap.set(rawToken, [
        'try {',
            '// >>>> scriptlet start',
            content,
            '// <<<< scriptlet end',
        '} catch (e) {',
            isDevBuild ? 'console.error(e);' : '',
        '}',
    ].join('\n'));
};

// Fill-in scriptlet argument placeholders.
const patchScriptlet = function(content, arglist) {
    if ( content.startsWith('function') && content.endsWith('}') ) {
        content = `(${content})({{args}});`;
    }
    for ( let i = 0; i < arglist.length; i++ ) {
        content = content.replace(`{{${i+1}}}`, arglist[i]);
    }
    return content.replace('{{args}}',
        JSON.stringify(arglist).slice(1,-1).replace(/\$/g, '$$$')
    );
};

const decompile = function(json) {
    const args = JSON.parse(json).map(s => s.replace(/,/g, '\\,'));
    if ( args.length === 0 ) { return '+js()'; }
    return `+js(${args.join(', ')})`;
};

/******************************************************************************/

scriptletFilteringEngine.logFilters = function(tabId, url, filters) {
    if ( typeof filters !== 'string' ) { return; }
    const fctxt = µb.filteringContext
            .duplicate()
            .fromTabId(tabId)
            .setRealm('extended')
            .setType('scriptlet')
            .setURL(url)
            .setDocOriginFromURL(url);
    for ( const filter of filters.split('\n') ) {
        fctxt.setFilter({ source: 'extended', raw: filter }).toLogger();
    }
};

scriptletFilteringEngine.reset = function() {
    scriptletDB.clear();
    duplicates.clear();
    contentScriptRegisterer.reset();
    scriptletCache.reset();
    acceptedCount = 0;
    discardedCount = 0;
};

scriptletFilteringEngine.freeze = function() {
    duplicates.clear();
    scriptletDB.collectGarbage();
    scriptletCache.reset();
};

scriptletFilteringEngine.compile = function(parser, writer) {
    writer.select('SCRIPTLET_FILTERS');

    // Only exception filters are allowed to be global.
    const isException = parser.isException();
    const normalized = normalizeRawFilter(parser, writer.properties.get('trustedSource'));

    // Can fail if there is a mismatch with trust requirement
    if ( normalized === undefined ) { return; }

    // Tokenless is meaningful only for exception filters.
    if ( normalized === '[]' && isException === false ) { return; }

    if ( parser.hasOptions() === false ) {
        if ( isException ) {
            writer.push([ 32, '', 1, normalized ]);
        }
        return;
    }

    // https://github.com/gorhill/uBlock/issues/3375
    //   Ignore instances of exception filter with negated hostnames,
    //   because there is no way to create an exception to an exception.

    for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
        if ( bad ) { continue; }
        let kind = 0;
        if ( isException ) {
            if ( not ) { continue; }
            kind |= 1;
        } else if ( not ) {
            kind |= 1;
        }
        writer.push([ 32, hn, kind, normalized ]);
    }
};

scriptletFilteringEngine.fromCompiledContent = function(reader) {
    reader.select('SCRIPTLET_FILTERS');

    while ( reader.next() ) {
        acceptedCount += 1;
        const fingerprint = reader.fingerprint();
        if ( duplicates.has(fingerprint) ) {
            discardedCount += 1;
            continue;
        }
        duplicates.add(fingerprint);
        const args = reader.args();
        if ( args.length < 4 ) { continue; }
        scriptletDB.store(args[1], args[2], args[3]);
    }
};

const $scriptlets = new Set();
const $exceptions = new Set();
const $mainWorldMap = new Map();
const $isolatedWorldMap = new Map();

scriptletFilteringEngine.retrieve = function(request) {
    if ( scriptletDB.size === 0 ) { return; }

    const hostname = request.hostname;

    // https://github.com/gorhill/uBlock/issues/2835
    //   Do not inject scriptlets if the site is under an `allow` rule.
    if (
        µb.userSettings.advancedUserEnabled &&
        sessionFirewall.evaluateCellZY(hostname, hostname, '*') === 2
    ) {
        return;
    }

    if ( scriptletCache.resetTime < reng.modifyTime ) {
        scriptletCache.reset();
    }

    let cacheDetails = scriptletCache.lookup(hostname);
    if ( cacheDetails === undefined ) {
        $scriptlets.clear();
        $exceptions.clear();

        scriptletDB.retrieve(hostname, [ $scriptlets, $exceptions ]);
        const entity = request.entity !== ''
            ? `${hostname.slice(0, -request.domain.length)}${request.entity}`
            : '*';
        scriptletDB.retrieve(entity, [ $scriptlets, $exceptions ], 1);
        if ( $scriptlets.size === 0 ) { return; }

        // Wholly disable scriptlet injection?
        if ( $exceptions.has('[]') ) {
            return {
                filters: [
                    { tabId: request.tabId, url: request.url, filter: '#@#+js()' }
                ]
            };
        }

        for ( const token of $exceptions ) {
            if ( $scriptlets.has(token) ) {
                $scriptlets.delete(token);
            } else {
                $exceptions.delete(token);
            }
        }
        for ( const token of $scriptlets ) {
            lookupScriptlet(token, $mainWorldMap, $isolatedWorldMap);
        }
        const mainWorldCode = [];
        for ( const js of $mainWorldMap.values() ) {
            mainWorldCode.push(js);
        }
        const isolatedWorldCode = [];
        for ( const js of $isolatedWorldMap.values() ) {
            isolatedWorldCode.push(js);
        }
        cacheDetails = {
            mainWorld: mainWorldCode.join('\n\n'),
            isolatedWorld: isolatedWorldCode.join('\n\n'),
            filters: [
                ...Array.from($scriptlets).map(s => `##${decompile(s)}`),
                ...Array.from($exceptions).map(s => `#@#${decompile(s)}`),
            ].join('\n'),
        };
        scriptletCache.add(hostname, cacheDetails);
        $mainWorldMap.clear();
        $isolatedWorldMap.clear();
    }

    if ( cacheDetails.mainWorld === '' && cacheDetails.isolatedWorld === '' ) {
        return { filters: cacheDetails.filters };
    }

    const scriptletGlobals = [
        [ 'warOrigin', vAPI.getURL('/web_accessible_resources') ],
        [ 'warSecret', vAPI.warSecret.long() ],
    ];

    if ( isDevBuild === undefined ) {
        isDevBuild = vAPI.webextFlavor.soup.has('devbuild');
    }
    if ( isDevBuild || µb.hiddenSettings.filterAuthorMode ) {
        scriptletGlobals.push([ 'canDebug', true ]);
    }

    return {
        mainWorld: cacheDetails.mainWorld === '' ? '' : [
            '(function() {',
            '// >>>> start of private namespace',
            '',
            µb.hiddenSettings.debugScriptlets ? 'debugger;' : ';',
            '',
            // For use by scriptlets to share local data among themselves
            `const scriptletGlobals = new Map(${JSON.stringify(scriptletGlobals, null, 2)});`,
            '',
            cacheDetails.mainWorld,
            '',
            '// <<<< end of private namespace',
            '})();',
        ].join('\n'),
        isolatedWorld: cacheDetails.isolatedWorld === '' ? '' : [
            'function() {',
            '// >>>> start of private namespace',
            '',
            µb.hiddenSettings.debugScriptlets ? 'debugger;' : ';',
            '',
            // For use by scriptlets to share local data among themselves
            `const scriptletGlobals = new Map(${JSON.stringify(scriptletGlobals, null, 2)});`,
            '',
            cacheDetails.isolatedWorld,
            '',
            '// <<<< end of private namespace',
            '}',
        ].join('\n'),
        filters: cacheDetails.filters,
    };
};

scriptletFilteringEngine.injectNow = function(details) {
    if ( typeof details.frameId !== 'number' ) { return; }
    const request = {
        tabId: details.tabId,
        frameId: details.frameId,
        url: details.url,
        hostname: hostnameFromURI(details.url),
        domain: undefined,
        entity: undefined
    };
    request.domain = domainFromHostname(request.hostname);
    request.entity = entityFromDomain(request.domain);
    const scriptletDetails = this.retrieve(request);
    if ( scriptletDetails === undefined ) {
        contentScriptRegisterer.unregister(request.hostname);
        return;
    }
    const contentScript = [];
    if ( µb.hiddenSettings.debugScriptletInjector ) {
        contentScript.push('debugger');
    }
    const { mainWorld = '', isolatedWorld = '', filters } = scriptletDetails;
    if ( mainWorld !== '' ) {
        contentScript.push(mainWorldInjector.assemble(request.hostname, mainWorld, filters));
    }
    if ( isolatedWorld !== '' ) {
        contentScript.push(isolatedWorldInjector.assemble(request.hostname, isolatedWorld));
    }
    const code = contentScript.join('\n\n');
    const isAlreadyInjected = contentScriptRegisterer.register(request.hostname, code);
    if ( isAlreadyInjected !== true ) {
        vAPI.tabs.executeScript(details.tabId, {
            code,
            frameId: details.frameId,
            matchAboutBlank: true,
            runAt: 'document_start',
        });
    }
    return scriptletDetails;
};

scriptletFilteringEngine.toSelfie = function() {
    return scriptletDB.toSelfie();
};

scriptletFilteringEngine.fromSelfie = function(selfie) {
    if ( selfie instanceof Object === false ) { return false; }
    if ( selfie.version !== VERSION ) { return false; }
    scriptletDB.fromSelfie(selfie);
    return true;
};

/******************************************************************************/

export default scriptletFilteringEngine;

/******************************************************************************/

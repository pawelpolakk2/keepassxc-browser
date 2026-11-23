'use strict';

const kpxcLoginScripts = {};
kpxcLoginScripts.isRunning = false;
kpxcLoginScripts.waitDefaultMs = 10000;
kpxcLoginScripts.waitMaxMs = 60000;
kpxcLoginScripts.sleepMaxMs = 10000;
kpxcLoginScripts.uncoverTimeoutMs = 5000;
kpxcLoginScripts.pollIntervalMs = 100;

// Returns true when a login script owns this page, so the normal fill must not run
kpxcLoginScripts.runIfMatching = async function(credential) {
    const script = kpxcLoginScripts.findMatchingScript(window.location.href);
    if (!script || !credential) {
        return false;
    }

    if (!kpxcLoginScripts.isRunning) {
        await kpxcLoginScripts.runAndReport(script, credential);
    }
    return true;
};

kpxcLoginScripts.findMatchingScript = function(url) {
    const scripts = kpxc.settings?.[LOGIN_SCRIPTS] ?? [];
    return scripts.find(it => kpxcLoginScriptLanguage.matchesUrl(it.urlPattern, url));
};

kpxcLoginScripts.runAndReport = async function(script, credential) {
    kpxcLoginScripts.isRunning = true;
    try {
        logDebug(`Running login script "${script.name}".`);
        await kpxcLoginScripts.run(script.source, credential);
        await sendMessage('page_set_manual_fill', ManualFill.NONE);
    } catch (err) {
        logError(`Login script "${script.name}" failed: ${err.message}`);
        kpxcUI.createNotification('error', tr('loginScriptFailed', [ script.name, err.message ]));
    } finally {
        kpxcLoginScripts.isRunning = false;
    }
};

kpxcLoginScripts.run = async function(source, credential) {
    const program = kpxcLoginScriptLanguage.parse(source);
    await kpxcLoginScriptLanguage.run(program, kpxcLoginScripts.createBuiltins(credential));
};

kpxcLoginScripts.createBuiltins = function(credential) {
    const self = kpxcLoginScripts;
    return {
        constants: {
            username: credential.login ?? '',
            password: credential.password ?? '',
        },
        functions: {
            pageUrl: () => window.location.href,
            stringField: (name) => self.findStringField(credential, self.requireText(name, 'name')),
            totp: () => self.requireTotp(credential),
            find: (selector) => self.wrapElement(self.findElements(selector)[0]),
            findAll: (selector) => self.findElements(selector).map(it => self.wrapElement(it)),
            findByText: (selector, text) => self.wrapElement(self.findVisibleElementWithText(selector, self.requireText(text, 'text'))),
            waitFor: (selector, timeoutMs) => self.waitForVisibleElement(selector, timeoutMs),
            attribute: (element, name) => self.requireElement(element).getAttribute(self.requireText(name, 'name')),
            text: (element) => self.extractText(self.requireElement(element)),
            isEnabled: (element) => self.isEnabled(self.requireElement(element)),
            isVisible: (element) => self.isVisible(self.requireElement(element)),
            type: (element, text) => self.typeText(self.requireElement(element), self.requireText(text, 'text')),
            click: (element) => self.clickElement(self.requireElement(element)),
            sleep: (ms) => self.sleep(self.requireNumberUpTo(ms, 'ms', self.sleepMaxMs)),
            match: (text, pattern) => self.matchPattern(self.requireText(text, 'text'), self.requireText(pattern, 'pattern')),
            toNumber: (text) => self.toNumber(text),
            log: (...values) => console.log(`${EXTENSION_NAME} login script:`, ...values.map(it => self.describeForLog(it))),
            fail: (message) => self.fail(String(message)),
        },
    };
};

kpxcLoginScripts.findStringField = function(credential, name) {
    const keys = [ `KPH: ${name}`, name ];
    for (const stringField of credential.stringFields ?? []) {
        const key = keys.find(it => Object.hasOwn(stringField, it));
        if (key) {
            return stringField[key];
        }
    }
    return null;
};

kpxcLoginScripts.requireTotp = async function(credential) {
    if (credential.totp?.length > 0) {
        const totp = await sendMessage('get_totp', [ credential.uuid, credential.totp ]);
        return totp || kpxcLoginScripts.fail('KeePassXC did not return a TOTP code.');
    }

    return kpxcLoginScripts.findStringField(credential, '{TOTP}') ?? kpxcLoginScripts.fail('The entry has no TOTP.');
};

kpxcLoginScripts.findElements = function(selector) {
    kpxcLoginScripts.requireText(selector, 'selector');
    try {
        return Array.from(document.querySelectorAll(selector));
    } catch {
        return kpxcLoginScripts.fail(`"${selector}" is not a valid CSS selector.`);
    }
};

kpxcLoginScripts.findVisibleElementWithText = function(selector, text) {
    return kpxcLoginScripts.findElements(selector)
        .find(it => kpxcLoginScripts.isVisible(it) && kpxcLoginScripts.extractText(it).includes(text));
};

kpxcLoginScripts.waitForVisibleElement = async function(selector, timeoutMs) {
    const timeout = timeoutMs === undefined
        ? kpxcLoginScripts.waitDefaultMs
        : kpxcLoginScripts.requireNumberUpTo(timeoutMs, 'timeoutMs', kpxcLoginScripts.waitMaxMs);
    const deadline = Date.now() + timeout;

    for (;;) {
        const element = kpxcLoginScripts.findElements(selector).find(it => kpxcLoginScripts.isVisible(it));
        if (element) {
            return kpxcLoginScripts.wrapElement(element);
        }
        if (Date.now() >= deadline) {
            return kpxcLoginScripts.fail(`No visible element matched "${selector}" within ${timeout} ms.`);
        }
        await kpxcLoginScripts.sleep(kpxcLoginScripts.pollIntervalMs);
    }
};

kpxcLoginScripts.extractText = function(element) {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
};

kpxcLoginScripts.isEnabled = function(element) {
    return !element.disabled && !element.readOnly;
};

kpxcLoginScripts.isVisible = function(element) {
    if (!element.isConnected || element.getClientRects().length === 0) {
        return false;
    }

    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
};

kpxcLoginScripts.typeText = async function(element, text) {
    if (!matchesWithNodeName(element, 'INPUT') && !matchesWithNodeName(element, 'TEXTAREA')) {
        kpxcLoginScripts.fail('Only input and textarea fields can be typed into.');
    }
    if (!kpxcLoginScripts.isEnabled(element)) {
        kpxcLoginScripts.fail(`The field ${kpxcLoginScripts.describeElement(element)} is disabled or read-only.`);
    }

    await kpxcLoginScripts.waitUntilUncovered(element);
    await kpxcFill.dispatchValueChange(element, text);
    if (element.value !== text) {
        kpxcLoginScripts.fail(`The page changed the value of ${kpxcLoginScripts.describeElement(element)} right after typing.`);
    }
};

// Pages often show a loading backdrop for a moment after the next step appears
kpxcLoginScripts.waitUntilUncovered = async function(element) {
    const deadline = Date.now() + kpxcLoginScripts.uncoverTimeoutMs;
    for (;;) {
        const coveringElement = kpxcLoginScripts.findCoveringElement(element);
        if (!coveringElement) {
            return;
        }
        if (Date.now() >= deadline) {
            kpxcLoginScripts.fail(`The field ${kpxcLoginScripts.describeElement(element)} is still covered by ${kpxcLoginScripts.describeElement(coveringElement)} after ${kpxcLoginScripts.uncoverTimeoutMs} ms.`);
        }
        await kpxcLoginScripts.sleep(kpxcLoginScripts.pollIntervalMs);
    }
};

// Checks what the user would really click, so transparent full-page popovers (Angular CDK) do not block typing
kpxcLoginScripts.findCoveringElement = function(element) {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const topElement = element.getRootNode().elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
    if (!topElement || element.contains(topElement)) {
        return undefined;
    }

    const labels = Array.from(element.labels ?? []);
    return labels.some(it => it.contains(topElement)) ? undefined : topElement;
};

kpxcLoginScripts.clickElement = function(element) {
    if (element.disabled) {
        kpxcLoginScripts.fail(`${kpxcLoginScripts.describeElement(element)} is disabled. The page may not have accepted the typed values.`);
    }
    element.click();
};

kpxcLoginScripts.sleep = function(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
};

kpxcLoginScripts.matchPattern = function(text, pattern) {
    let regex;
    try {
        regex = new RegExp(pattern);
    } catch {
        return kpxcLoginScripts.fail(`"${pattern}" is not a valid regular expression.`);
    }

    const found = text.match(regex);
    return found ? Array.from(found, it => it ?? null) : null;
};

kpxcLoginScripts.toNumber = function(value) {
    if (typeof value === 'number') {
        return value;
    }

    const text = kpxcLoginScripts.requireText(value, 'text').trim();
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(text)) {
        kpxcLoginScripts.fail(`"${text}" is not a number.`);
    }
    return Number(text);
};

kpxcLoginScripts.wrapElement = function(element) {
    return element ? new kpxcLoginScriptLanguage.ScriptElement(element) : null;
};

kpxcLoginScripts.requireElement = function(value) {
    if (!(value instanceof kpxcLoginScriptLanguage.ScriptElement)) {
        const found = value === null ? 'null. Did find() find nothing?' : `${typeof value}.`;
        kpxcLoginScripts.fail(`Expected an element, but got ${found}`);
    }
    return value.toElement();
};

kpxcLoginScripts.requireText = function(value, parameterName) {
    if (typeof value !== 'string') {
        kpxcLoginScripts.fail(`${parameterName} must be text, but got ${value === null ? 'null' : typeof value}.`);
    }
    return value;
};

kpxcLoginScripts.requireNumberUpTo = function(value, parameterName, max) {
    if (typeof value !== 'number' || value < 0 || value > max) {
        kpxcLoginScripts.fail(`${parameterName} must be a number from 0 to ${max}.`);
    }
    return value;
};

kpxcLoginScripts.describeElement = function(element) {
    return `<${element.nodeName.toLowerCase()}${kpxcLoginScripts.extractSelectorHint(element)}>`;
};

kpxcLoginScripts.extractSelectorHint = function(element) {
    if (element.id) {
        return `#${element.id}`;
    }
    return element.classList?.length > 0 ? `.${element.classList[0]}` : '';
};

kpxcLoginScripts.describeForLog = function(value) {
    if (value instanceof kpxcLoginScriptLanguage.ScriptElement) {
        return kpxcLoginScripts.describeElement(value.toElement());
    }
    return Array.isArray(value) ? value.map(it => kpxcLoginScripts.describeForLog(it)) : value;
};

kpxcLoginScripts.fail = function(reason) {
    throw new kpxcLoginScriptLanguage.ScriptError(reason);
};

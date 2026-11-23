import { test, expect } from '@playwright/test';
import {
    BUILTINS,
    EXAMPLE,
    ScriptElement,
    findProblems,
    findUrlPatternProblems,
    matchesUrl,
    parse,
    run,
} from '../keepassxc-browser/common/login-script.js';

const runAndCollectLogs = async (source: string, functions = {}, limits = {}) => {
    const logs: unknown[] = [];
    const builtins = {
        constants: { username: 'user', password: 'ABCDEFGH' },
        functions: { log: (...values: unknown[]) => logs.push(values.length === 1 ? values[0] : values), ...functions },
    };
    await run(parse(source), builtins, limits);
    return logs;
};

test('Login script runs JavaScript-like statements', async () => {
    const logs = await runAndCollectLogs(`
        const name = "kpxc";
        let total = 0;
        for (let i = 0; i < 5; i++) {
            if (i === 1) {
                continue;
            }
            total += i;
        }
        let count = 0;
        while (true) {
            count++;
            if (count >= 3) break;
        }
        const letters = [];
        for (const letter of password) {
            if (letter === "C") {
                break;
            }
            log(letter);
        }
        log(total, count, name.length, password[7], \`\${username}-\${1 + 2}\`);
        log(null ?? "fallback", "" || "empty", 2 > 1 ? "yes" : "no", -total + 1, !false);
        log(7 % 3, 10 / 4, "a" < "b", [1, 2, 3].length);
    `);

    expect(logs).toEqual([
        'A',
        'B',
        [ 9, 3, 4, 'H', 'user-3' ],
        [ 'fallback', 'empty', 'yes', -8, true ],
        [ 1, 2.5, true, 3 ],
    ]);
});

test('Login script return stops the script', async () => {
    const logs = await runAndCollectLogs(`
        log("before");
        if (username === "user") {
            return;
        }
        log("after");
    `);
    expect(logs).toEqual([ 'before' ]);
});

test('Login script rejects names that are not built in', async () => {
    const escapes = [
        'eval("1")',
        'window.location',
        'document',
        'fetch("https://example.com")',
        'globalThis',
        'Function("return 1")()',
        'constructor',
        '__proto__',
        'chrome.runtime',
        'browser',
        'kpxc',
        'setTimeout("1", 1)',
        'XMLHttpRequest',
    ];

    for (const source of escapes) {
        expect(findProblems(source), source).toHaveLength(1);
        expect(findProblems(source)[0], source).toMatch(/Unknown (name|function)|Only "\.length"|Only the built-in functions/);
    }
});

test('Login script rejects syntax outside the sandbox', async () => {
    const forbidden = {
        'function f() {}': 'is not supported',
        'const f = () => 1': 'Arrow functions',
        'new Image()': 'is not supported',
        'class A {}': 'is not supported',
        'this': 'is not supported',
        'var a = 1': 'is not supported',
        'import("x")': 'is not supported',
        'typeof password': 'is not supported',
        'password.constructor': 'Only ".length"',
        'password.at(0)': 'Only ".length"',
        'password?.length': '"?." is not supported',
        '(password)(1)': 'is not a function',
        'log(1)(2)': 'Only the built-in functions',
        'password[0] = "x"': 'Only variables can be assigned',
        'const find = 1': 'built-in name',
        'const a = 1, b = 2': 'one variable per line',
        'log("\\d")': 'Unknown escape',
        'log(0x10)': 'plain decimal numbers',
        'log(1 @ 2)': 'is not allowed',
        'log(...[1])': 'spread operator',
        'log("open': 'never closed',
        '/* open': 'never closed',
    };

    for (const [ source, expected ] of Object.entries(forbidden)) {
        const problems = findProblems(source);
        expect(problems, source).toHaveLength(1);
        expect(problems[0], source).toContain(expected);
    }
});

test('Login script cannot read members through indexes', async () => {
    await expect(runAndCollectLogs('log([1]["constructor"])')).rejects.toThrow('The index must be a whole number');
    await expect(runAndCollectLogs('log(password[8])')).rejects.toThrow('Index 8 is outside the text of length 8');
    await expect(runAndCollectLogs('log(password[-1])')).rejects.toThrow('outside the text');
    await expect(runAndCollectLogs('log(username.length[0])')).rejects.toThrow('[ ] needs a list or text');
});

test('Login script reports runtime errors with line numbers', async () => {
    await expect(runAndCollectLogs('const a = 1;\na = 2;')).rejects.toThrow('Line 2, column 1: "a" is a const');
    await expect(runAndCollectLogs('let a = 1;\nlet a = 2;')).rejects.toThrow('"a" is already declared');
    await expect(runAndCollectLogs('log(1 - "a")')).rejects.toThrow('Expected a number');
    await expect(runAndCollectLogs('log(1 < "a")')).rejects.toThrow('compares two numbers or two texts');
    await expect(runAndCollectLogs('log(log)')).rejects.toThrow('"log" is a function');
    await expect(runAndCollectLogs('password = "x"')).rejects.toThrow('built-in name and cannot be changed');
    expect(findProblems('username()')[0]).toContain('"username" is not a function');
    await expect(runAndCollectLogs('{ let inner = 1; }\nlog(inner)')).rejects.toThrow('Line 2, column 5: Unknown name "inner"');
});

test('Login script stops endless loops and long runs', async () => {
    await expect(runAndCollectLogs('while (true) {}', {}, { maxSteps: 1000 })).rejects.toThrow('more than 1000 steps');
    await expect(runAndCollectLogs('for (;;) {}', {}, { maxSteps: 1000 })).rejects.toThrow('more than 1000 steps');

    const sleep = () => new Promise(resolve => setTimeout(resolve, 20));
    await expect(runAndCollectLogs('while (true) { sleep(1); }', { sleep }, { maxDurationMs: 100 }))
        .rejects.toThrow('ran longer than 0.1 seconds');
});

test('Login script checks built-in calls and their results', async () => {
    const fail = (message: string) => {
        throw new Error(message);
    };
    const leak = () => ({ secret: true });
    const leakFunction = () => () => 1;

    await expect(runAndCollectLogs('find()', { find: () => null })).rejects.toThrow('find(selector) got 0 argument(s)');
    await expect(runAndCollectLogs('\n  fail("boom")', { fail })).rejects.toThrow('Line 2, column 3: fail(): unexpected error: boom');
    await expect(runAndCollectLogs('pageUrl()', { pageUrl: leak })).rejects.toThrow('returned a value scripts cannot use');
    await expect(runAndCollectLogs('pageUrl()', { pageUrl: leakFunction })).rejects.toThrow('returned a value scripts cannot use');
    await expect(runAndCollectLogs('log("x" + find("a"))', { find: () => new ScriptElement({}) })).rejects.toThrow('Cannot turn an element into text');
});

test('Login script example and built-in list are valid', async () => {
    expect(findProblems(EXAMPLE)).toEqual([]);

    const names = BUILTINS.map(it => it.name);
    expect(new Set(names).size).toBe(names.length);
});

test('Login script URL patterns', async () => {
    expect(findUrlPatternProblems('^https://www\\.pekao24\\.pl/')).toEqual([]);
    expect(findUrlPatternProblems('^https?://example\\.com/')).toEqual([]);
    expect(findUrlPatternProblems('pekao24')).toHaveLength(1);
    expect(findUrlPatternProblems('')).toHaveLength(1);
    expect(findUrlPatternProblems('^https://(')[0]).toContain('not a valid regular expression');

    expect(matchesUrl('^https://www\\.pekao24\\.pl/', 'https://www.pekao24.pl/logowanie')).toBe(true);
    expect(matchesUrl('^https://www\\.pekao24\\.pl/', 'https://www.pekao24.pl.evil.net/logowanie')).toBe(false);
    expect(matchesUrl('^https://www\\.pekao24\\.pl/', 'http://www.pekao24.pl/logowanie')).toBe(false);
    expect(matchesUrl('pekao24', 'https://www.pekao24.pl/')).toBe(false);
});

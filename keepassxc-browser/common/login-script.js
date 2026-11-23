'use strict';

// Custom Login Scripts: a small JavaScript-like language run by an interpreter.
// Scripts never reach eval, the page or the extension. They can use only the names in BUILTINS.

const kpxcLoginScriptLanguage = (function() {
    const MAX_STEPS = 100000;
    const MAX_DURATION_MS = 60000;
    const URL_PATTERN_PREFIXES = [ '^https://', '^http://', '^https?://' ];

    const BUILTINS = [
        { name: 'username', kind: 'constant', returns: 'text', description: 'Username of the selected entry.' },
        { name: 'password', kind: 'constant', returns: 'text', description: 'Password of the selected entry. password[0] is the first character.' },
        { name: 'pageUrl', params: [], returns: 'text', description: 'Address of the current page.' },
        { name: 'stringField', params: [ 'name' ], returns: 'text or null', description: 'Value of the entry attribute "KPH: name".' },
        { name: 'totp', params: [], returns: 'text', description: 'Current TOTP code of the entry.' },
        { name: 'find', params: [ 'selector' ], returns: 'element or null', description: 'First element that matches the CSS selector.' },
        { name: 'findAll', params: [ 'selector' ], returns: 'list of elements', description: 'All elements that match the CSS selector, in page order.' },
        { name: 'findByText', params: [ 'selector', 'text' ], returns: 'element or null', description: 'First visible element that matches the selector and contains the text.' },
        { name: 'waitFor', params: [ 'selector', 'timeoutMs?' ], returns: 'element', description: 'Waits until a visible element matches the selector. Default 10000 ms, at most 60000 ms.' },
        { name: 'attribute', params: [ 'element', 'name' ], returns: 'text or null', description: 'Value of an attribute of the element.' },
        { name: 'text', params: [ 'element' ], returns: 'text', description: 'Visible text of the element, trimmed.' },
        { name: 'isEnabled', params: [ 'element' ], returns: 'true or false', description: 'True when the field is neither disabled nor read-only.' },
        { name: 'isVisible', params: [ 'element' ], returns: 'true or false', description: 'True when the element is shown on the page.' },
        { name: 'type', params: [ 'element', 'text' ], returns: 'nothing', description: 'Types the text into the field, with the same events as a normal fill.' },
        { name: 'click', params: [ 'element' ], returns: 'nothing', description: 'Clicks the element.' },
        { name: 'sleep', params: [ 'ms' ], returns: 'nothing', description: 'Waits the given time, at most 10000 ms.' },
        { name: 'match', params: [ 'text', 'pattern' ], returns: 'list or null', description: 'Matches a regular expression. Returns [whole match, group 1, ...] or null.' },
        { name: 'toNumber', params: [ 'text' ], returns: 'number', description: 'Turns text like "12" into the number 12.' },
        { name: 'log', params: [ 'value', '...values' ], returns: 'nothing', description: 'Writes the values to the browser console of the page.' },
        { name: 'fail', params: [ 'message' ], returns: 'nothing', description: 'Stops the script and shows the message.' },
    ];

    const EXAMPLE = [
        'if (find("#customer")) {',
        '    type(find("#customer"), username);',
        '    click(findByText("button", "Next"));',
        '}',
        '',
        'waitFor("#password input:not([disabled])");',
        'for (const input of findAll("#password input")) {',
        '    if (isEnabled(input)) {',
        '        const index = toNumber(match(attribute(input, "id"), "-(\\\\d+)$")[1]);',
        '        type(input, password[index]);',
        '    }',
        '}',
    ].join('\n');

    const KEYWORDS = new Set([
        'break', 'const', 'continue', 'else', 'false', 'for', 'if', 'let', 'null', 'of', 'return', 'true', 'while'
    ]);

    const UNSUPPORTED_WORDS = new Set([
        'async', 'await', 'case', 'catch', 'class', 'debugger', 'default', 'delete', 'do', 'export', 'extends',
        'finally', 'function', 'import', 'in', 'instanceof', 'new', 'super', 'switch', 'this', 'throw', 'try',
        'typeof', 'var', 'void', 'with', 'yield'
    ]);

    const PUNCTUATORS = [
        '===', '!==', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '+=', '-=', '++', '--', '?.',
        '(', ')', '{', '}', '[', ']', ',', ';', '.', '?', ':', '!', '+', '-', '*', '/', '%', '=', '<', '>'
    ];

    const UNSUPPORTED_PUNCTUATORS = {
        '=>': 'Arrow functions are not supported.',
        '...': 'The spread operator ... is not supported.',
        '?.': '"?." is not supported. Check for null with if.',
    };

    const STRING_ESCAPES = { 'n': '\n', 't': '\t', 'r': '\r', '\\': '\\', '\'': '\'', '"': '"', '`': '`', '$': '$', '/': '/' };

    const BINARY_PRECEDENCE = [
        [ '||', '??' ],
        [ '&&' ],
        [ '==', '!=', '===', '!==' ],
        [ '<', '<=', '>', '>=' ],
        [ '+', '-' ],
        [ '*', '/', '%' ],
    ];

    class LoginScriptError extends Error {
        constructor(reason, position) {
            super(position ? `Line ${position.line}, column ${position.column}: ${reason}` : reason);
            this.name = 'LoginScriptError';
            this.reason = reason;
            this.position = position;
        }
    }

    class LoginScriptElement {
        #element;

        constructor(element) {
            this.#element = element;
            Object.freeze(this);
        }

        toElement() {
            return this.#element;
        }
    }

    const builtinByName = new Map(BUILTINS.map(it => [ it.name, it ]));

    const tokenize = function(source, start = { offset: 0, line: 1, column: 1 }) {
        const reader = { source, offset: start.offset, line: start.line, column: start.column };
        const tokens = [];
        let newlineBefore = false;

        while (reader.offset < source.length) {
            const character = source[reader.offset];
            if (character === '\n') {
                newlineBefore = true;
                advanceReader(reader, 1);
            } else if (/\s/.test(character)) {
                advanceReader(reader, 1);
            } else if (source.startsWith('//', reader.offset)) {
                skipLineComment(reader);
            } else if (source.startsWith('/*', reader.offset)) {
                newlineBefore = skipBlockComment(reader) || newlineBefore;
            } else {
                tokens.push({ ...readToken(reader), newlineBefore });
                newlineBefore = false;
            }
        }

        tokens.push({ type: 'end', value: '', position: positionOf(reader), newlineBefore });
        return tokens;
    };

    const positionOf = function(reader) {
        return { offset: reader.offset, line: reader.line, column: reader.column };
    };

    const advanceReader = function(reader, count) {
        for (let i = 0; i < count; i++) {
            if (reader.source[reader.offset] === '\n') {
                reader.line++;
                reader.column = 1;
            } else {
                reader.column++;
            }
            reader.offset++;
        }
    };

    const skipLineComment = function(reader) {
        while (reader.offset < reader.source.length && reader.source[reader.offset] !== '\n') {
            advanceReader(reader, 1);
        }
    };

    const skipBlockComment = function(reader) {
        const position = positionOf(reader);
        const end = reader.source.indexOf('*/', reader.offset + 2);
        if (end === -1) {
            throw new LoginScriptError('This comment is never closed with */.', position);
        }

        const hasNewline = reader.source.slice(reader.offset, end).includes('\n');
        advanceReader(reader, end + 2 - reader.offset);
        return hasNewline;
    };

    const readToken = function(reader) {
        const position = positionOf(reader);
        const character = reader.source[reader.offset];

        if (/[0-9]/.test(character)) {
            return readNumber(reader, position);
        }
        if (character === '"' || character === '\'') {
            return { type: 'string', value: readQuotedText(reader, character), position };
        }
        if (character === '`') {
            return readTemplate(reader, position);
        }
        if (/[A-Za-z_$]/.test(character)) {
            return readWord(reader, position);
        }

        const punctuator = PUNCTUATORS.find(it => reader.source.startsWith(it, reader.offset));
        if (!punctuator) {
            throw new LoginScriptError(`The character "${character}" is not allowed here.`, position);
        }

        if (Object.hasOwn(UNSUPPORTED_PUNCTUATORS, punctuator)) {
            throw new LoginScriptError(UNSUPPORTED_PUNCTUATORS[punctuator], position);
        }

        advanceReader(reader, punctuator.length);
        return { type: 'punctuator', value: punctuator, position };
    };

    const readNumber = function(reader, position) {
        const match = /^[0-9]+(\.[0-9]+)?/.exec(reader.source.slice(reader.offset));
        advanceReader(reader, match[0].length);
        if (/[A-Za-z_$]/.test(reader.source[reader.offset] ?? '')) {
            throw new LoginScriptError('Only plain decimal numbers like 12 or 1.5 are supported.', position);
        }
        return { type: 'number', value: Number(match[0]), position };
    };

    const readWord = function(reader, position) {
        const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(reader.source.slice(reader.offset));
        advanceReader(reader, match[0].length);

        const word = match[0];
        if (UNSUPPORTED_WORDS.has(word)) {
            throw new LoginScriptError(`"${word}" is not supported in login scripts.`, position);
        }
        return { type: KEYWORDS.has(word) ? 'keyword' : 'name', value: word, position };
    };

    const readQuotedText = function(reader, quote) {
        const position = positionOf(reader);
        advanceReader(reader, 1);

        let text = '';
        while (reader.source[reader.offset] !== quote) {
            const character = reader.source[reader.offset];
            if (character === undefined || character === '\n') {
                throw new LoginScriptError('This text is never closed with a quote.', position);
            }
            text += character === '\\' ? readEscape(reader) : character;
            advanceReader(reader, 1);
        }

        advanceReader(reader, 1);
        return text;
    };

    const readEscape = function(reader) {
        const position = positionOf(reader);
        advanceReader(reader, 1);

        const character = reader.source[reader.offset];
        if (!Object.hasOwn(STRING_ESCAPES, character)) {
            throw new LoginScriptError(`Unknown escape "\\${character}". Write "\\\\${character}" for a backslash.`, position);
        }
        return STRING_ESCAPES[character];
    };

    const readTemplate = function(reader, position) {
        advanceReader(reader, 1);

        const texts = [];
        const expressions = [];
        let text = '';

        while (reader.source[reader.offset] !== '`') {
            const character = reader.source[reader.offset];
            if (character === undefined) {
                throw new LoginScriptError('This text is never closed with `.', position);
            }

            if (reader.source.startsWith('${', reader.offset)) {
                texts.push(text);
                text = '';
                advanceReader(reader, 2);
                expressions.push(readTemplateExpression(reader));
            } else {
                text += character === '\\' ? readEscape(reader) : character;
                advanceReader(reader, 1);
            }
        }

        advanceReader(reader, 1);
        texts.push(text);
        return { type: 'template', value: { texts, expressions }, position };
    };

    const readTemplateExpression = function(reader) {
        const start = positionOf(reader);
        const end = findTemplateExpressionEnd(reader.source, reader.offset, start);
        const tokens = tokenize(reader.source.slice(0, end), start);
        advanceReader(reader, end + 1 - reader.offset);
        return tokens;
    };

    const findTemplateExpressionEnd = function(source, offset, start) {
        let depth = 0;
        let quote;

        for (let i = offset; i < source.length; i++) {
            const character = source[i];
            if (quote) {
                if (character === '\\') {
                    i++;
                } else if (character === quote) {
                    quote = undefined;
                }
            } else if (character === '"' || character === '\'' || character === '`') {
                quote = character;
            } else if (character === '{') {
                depth++;
            } else if (character === '}') {
                if (depth === 0) {
                    return i;
                }
                depth--;
            }
        }

        throw new LoginScriptError('This ${ is never closed with }.', start);
    };

    class LoginScriptParser {
        constructor(tokens) {
            this.tokens = tokens;
            this.index = 0;
        }

        parseProgram() {
            const body = [];
            while (!this.isAt('end')) {
                body.push(this.parseStatement());
            }
            return { type: 'Program', body };
        }

        parseStatement() {
            const token = this.peek();
            if (this.isPunctuator('{')) {
                return this.parseBlock();
            }
            if (token.type === 'keyword') {
                const keywordParsers = {
                    'const': () => this.parseDeclarationStatement(),
                    'let': () => this.parseDeclarationStatement(),
                    'if': () => this.parseIf(),
                    'while': () => this.parseWhile(),
                    'for': () => this.parseFor(),
                    'break': () => this.parseJump('Break'),
                    'continue': () => this.parseJump('Continue'),
                    'return': () => this.parseReturn(),
                };
                if (Object.hasOwn(keywordParsers, token.value)) {
                    return keywordParsers[token.value]();
                }
            }

            const statement = this.parseSimpleStatement();
            this.endStatement();
            return statement;
        }

        parseBlock() {
            const position = this.expectPunctuator('{').position;
            const body = [];
            while (!this.isPunctuator('}')) {
                if (this.isAt('end')) {
                    throw new LoginScriptError('This block is never closed with }.', position);
                }
                body.push(this.parseStatement());
            }
            this.next();
            return { type: 'Block', body, position };
        }

        parseDeclarationStatement() {
            const declaration = this.parseDeclaration();
            this.endStatement();
            return declaration;
        }

        parseDeclaration() {
            const keyword = this.next();
            const name = this.expectVariableName();
            let init = null;
            if (this.isPunctuator('=')) {
                this.next();
                init = this.parseExpression();
            } else if (keyword.value === 'const') {
                throw new LoginScriptError(`const "${name.value}" needs a value.`, name.position);
            }
            if (this.isPunctuator(',')) {
                throw new LoginScriptError('Declare one variable per line.', this.peek().position);
            }
            return { type: 'Declaration', isConstant: keyword.value === 'const', name: name.value, init, position: keyword.position };
        }

        parseIf() {
            const position = this.next().position;
            const test = this.parseCondition();
            const consequent = this.parseStatement();
            let alternate = null;
            if (this.isKeyword('else')) {
                this.next();
                alternate = this.parseStatement();
            }
            return { type: 'If', test, consequent, alternate, position };
        }

        parseWhile() {
            const position = this.next().position;
            const test = this.parseCondition();
            return { type: 'While', test, body: this.parseStatement(), position };
        }

        parseFor() {
            const position = this.next().position;
            this.expectPunctuator('(');

            if (this.isKeyword('const') || this.isKeyword('let')) {
                const afterName = this.tokens[this.index + 2];
                if (afterName?.type === 'keyword' && afterName.value === 'of') {
                    return this.parseForOf(position);
                }
            }

            const init = this.isPunctuator(';') ? null : this.parseForInit();
            this.expectPunctuator(';');
            const test = this.isPunctuator(';') ? null : this.parseExpression();
            this.expectPunctuator(';');
            const update = this.isPunctuator(')') ? null : this.parseSimpleStatement();
            this.expectPunctuator(')');
            return { type: 'For', init, test, update, body: this.parseStatement(), position };
        }

        parseForInit() {
            return this.isKeyword('const') || this.isKeyword('let') ? this.parseDeclaration() : this.parseSimpleStatement();
        }

        parseForOf(position) {
            const isConstant = this.next().value === 'const';
            const name = this.expectVariableName().value;
            this.next();
            const iterable = this.parseExpression();
            this.expectPunctuator(')');
            return { type: 'ForOf', isConstant, name, iterable, body: this.parseStatement(), position };
        }

        parseJump(type) {
            const position = this.next().position;
            this.endStatement();
            return { type, position };
        }

        parseReturn() {
            const position = this.next().position;
            if (!this.isPunctuator(';') && !this.isPunctuator('}') && !this.isAt('end') && !this.peek().newlineBefore) {
                this.parseExpression();
            }
            this.endStatement();
            return { type: 'Return', position };
        }

        parseCondition() {
            this.expectPunctuator('(');
            const test = this.parseExpression();
            this.expectPunctuator(')');
            return test;
        }

        parseSimpleStatement() {
            const token = this.peek();
            const following = this.tokens[this.index + 1];
            if (token.type === 'name' && following?.type === 'punctuator') {
                if ([ '=', '+=', '-=' ].includes(following.value)) {
                    this.next();
                    this.next();
                    return { type: 'Assignment', name: token.value, operator: following.value, value: this.parseExpression(), position: token.position };
                }
                if ([ '++', '--' ].includes(following.value)) {
                    this.next();
                    this.next();
                    const operator = following.value === '++' ? '+=' : '-=';
                    const value = { type: 'Literal', value: 1, position: following.position };
                    return { type: 'Assignment', name: token.value, operator, value, position: token.position };
                }
            }

            const expression = this.parseExpression();
            if (this.isPunctuator('=') || this.isPunctuator('+=') || this.isPunctuator('-=')) {
                throw new LoginScriptError('Only variables can be assigned. Elements and lists cannot be changed.', this.peek().position);
            }
            return { type: 'ExpressionStatement', expression, position: token.position };
        }

        endStatement() {
            if (this.isPunctuator(';')) {
                this.next();
                return;
            }
            if (this.isPunctuator('}') || this.isAt('end') || this.peek().newlineBefore) {
                return;
            }
            throw new LoginScriptError(`Expected ; but found "${this.peek().value}".`, this.peek().position);
        }

        parseExpression() {
            const test = this.parseBinary(0);
            if (!this.isPunctuator('?')) {
                return test;
            }

            const position = this.next().position;
            const consequent = this.parseExpression();
            this.expectPunctuator(':');
            const alternate = this.parseExpression();
            return { type: 'Conditional', test, consequent, alternate, position };
        }

        parseBinary(level) {
            if (level === BINARY_PRECEDENCE.length) {
                return this.parseUnary();
            }

            let left = this.parseBinary(level + 1);
            while (this.peek().type === 'punctuator' && BINARY_PRECEDENCE[level].includes(this.peek().value)) {
                const operator = this.next();
                const right = this.parseBinary(level + 1);
                left = { type: 'Binary', operator: operator.value, left, right, position: operator.position };
            }
            return left;
        }

        parseUnary() {
            if (this.isPunctuator('!') || this.isPunctuator('-') || this.isPunctuator('+')) {
                const operator = this.next();
                return { type: 'Unary', operator: operator.value, argument: this.parseUnary(), position: operator.position };
            }
            return this.parsePostfix();
        }

        parsePostfix() {
            let expression = this.parsePrimary();
            for (;;) {
                if (this.isPunctuator('(')) {
                    expression = this.parseCall(expression);
                } else if (this.isPunctuator('.')) {
                    expression = this.parseMember(expression);
                } else if (this.isPunctuator('[')) {
                    const position = this.next().position;
                    const index = this.parseExpression();
                    this.expectPunctuator(']');
                    expression = { type: 'Index', object: expression, index, position };
                } else {
                    return expression;
                }
            }
        }

        parseCall(callee) {
            if (callee.type !== 'Name') {
                throw new LoginScriptError('Only the built-in functions can be called.', callee.position);
            }

            this.next();
            const args = [];
            while (!this.isPunctuator(')')) {
                args.push(this.parseExpression());
                if (!this.isPunctuator(')')) {
                    this.expectPunctuator(',');
                }
            }
            this.next();
            return { type: 'Call', name: callee.value, args, position: callee.position };
        }

        parseMember(object) {
            this.next();
            const property = this.peek();
            if (property.type !== 'name' || property.value !== 'length') {
                throw new LoginScriptError('Only ".length" can be read. Use the built-in functions for everything else.', property.position);
            }
            this.next();
            return { type: 'Length', object, position: property.position };
        }

        parsePrimary() {
            const token = this.next();
            if (token.type === 'number' || token.type === 'string') {
                return { type: 'Literal', value: token.value, position: token.position };
            }
            if (token.type === 'template') {
                const expressions = token.value.expressions.map(it => new LoginScriptParser(it).parseTemplateExpression());
                return { type: 'Template', texts: token.value.texts, expressions, position: token.position };
            }
            if (token.type === 'keyword' && [ 'true', 'false', 'null' ].includes(token.value)) {
                return { type: 'Literal', value: JSON.parse(token.value), position: token.position };
            }
            if (token.type === 'name') {
                return { type: 'Name', value: token.value, position: token.position };
            }
            if (token.type === 'punctuator' && token.value === '(') {
                const expression = this.parseExpression();
                this.expectPunctuator(')');
                return expression;
            }
            if (token.type === 'punctuator' && token.value === '[') {
                return this.parseList(token.position);
            }
            throw new LoginScriptError(this.describeUnexpected(token), token.position);
        }

        parseTemplateExpression() {
            const expression = this.parseExpression();
            if (!this.isAt('end')) {
                throw new LoginScriptError('Only one expression is allowed inside ${ }.', this.peek().position);
            }
            return expression;
        }

        parseList(position) {
            const items = [];
            while (!this.isPunctuator(']')) {
                items.push(this.parseExpression());
                if (!this.isPunctuator(']')) {
                    this.expectPunctuator(',');
                }
            }
            this.next();
            return { type: 'List', items, position };
        }

        describeUnexpected(token) {
            return token.type === 'end' ? 'The script ends too early.' : `Unexpected "${token.value}".`;
        }

        expectVariableName() {
            const token = this.next();
            if (token.type !== 'name') {
                throw new LoginScriptError('Expected a variable name.', token.position);
            }
            if (builtinByName.has(token.value)) {
                throw new LoginScriptError(`"${token.value}" is a built-in name. Pick another variable name.`, token.position);
            }
            return token;
        }

        expectPunctuator(value) {
            const token = this.next();
            if (token.type !== 'punctuator' || token.value !== value) {
                const found = token.type === 'end' ? 'the end of the script' : `"${token.value}"`;
                throw new LoginScriptError(`Expected "${value}" but found ${found}.`, token.position);
            }
            return token;
        }

        peek() {
            return this.tokens[this.index];
        }

        next() {
            const token = this.tokens[this.index];
            if (token.type !== 'end') {
                this.index++;
            }
            return token;
        }

        isAt(type) {
            return this.peek().type === type;
        }

        isPunctuator(value) {
            return this.peek().type === 'punctuator' && this.peek().value === value;
        }

        isKeyword(value) {
            return this.peek().type === 'keyword' && this.peek().value === value;
        }
    }

    const parse = function(source) {
        if (typeof source !== 'string') {
            throw new LoginScriptError('The script must be text.');
        }

        const program = new LoginScriptParser(tokenize(source)).parseProgram();
        requireKnownNames(program);
        return program;
    };

    // Static check, so the options page reports a typo like "eval" or "documnet" before the script runs
    const requireKnownNames = function(program) {
        const nodes = flattenNodes(program);
        const declaredNames = new Set(nodes.filter(it => it.type === 'Declaration' || it.type === 'ForOf').map(it => it.name));

        for (const node of nodes) {
            if (node.type === 'Call') {
                requireBuiltinFunction(node);
            } else if (node.type === 'Name' || node.type === 'Assignment') {
                requireKnownName(node.type === 'Name' ? node.value : node.name, declaredNames, node.position);
            }
        }
    };

    const requireBuiltinFunction = function(node) {
        const builtin = builtinByName.get(node.name);
        if (!builtin) {
            throw new LoginScriptError(`Unknown function "${node.name}". Only the built-in functions can be called.`, node.position);
        }
        if (builtin.kind === 'constant') {
            throw new LoginScriptError(`"${node.name}" is not a function.`, node.position);
        }
    };

    const requireKnownName = function(name, declaredNames, position) {
        if (!declaredNames.has(name) && !builtinByName.has(name)) {
            throw new LoginScriptError(`Unknown name "${name}". Only the built-in functions and your own variables can be used.`, position);
        }
    };

    const flattenNodes = function(value) {
        if (Array.isArray(value)) {
            return value.flatMap(it => flattenNodes(it));
        }
        if (!value || typeof value !== 'object' || !value.type) {
            return [];
        }

        const children = Object.keys(value)
            .filter(it => it !== 'position')
            .flatMap(it => flattenNodes(value[it]));
        return [ value, ...children ];
    };

    const findProblems = function(source) {
        try {
            parse(source);
            return [];
        } catch (err) {
            if (err instanceof LoginScriptError) {
                return [ err.message ];
            }
            throw err;
        }
    };

    const findUrlPatternProblems = function(pattern) {
        if (typeof pattern !== 'string' || pattern.length === 0) {
            return [ 'The URL pattern is empty.' ];
        }
        if (!URL_PATTERN_PREFIXES.some(it => pattern.startsWith(it))) {
            return [ 'The URL pattern must start with ^https:// so it cannot match another site by accident.' ];
        }

        try {
            new RegExp(pattern);
            return [];
        } catch (err) {
            return [ `The URL pattern is not a valid regular expression: ${err.message}` ];
        }
    };

    const matchesUrl = function(pattern, url) {
        if (findUrlPatternProblems(pattern).length > 0) {
            return false;
        }
        return new RegExp(pattern).test(url);
    };

    class LoginScriptScope {
        constructor(parent) {
            this.parent = parent;
            this.bindings = new Map();
        }

        declare(name, value, isConstant, position) {
            if (this.bindings.has(name)) {
                throw new LoginScriptError(`"${name}" is already declared.`, position);
            }
            this.bindings.set(name, { value, isConstant });
        }

        findBinding(name) {
            for (let scope = this; scope; scope = scope.parent) {
                if (scope.bindings.has(name)) {
                    return scope.bindings.get(name);
                }
            }
            return undefined;
        }
    }

    const BREAK = Symbol('break');
    const CONTINUE = Symbol('continue');
    const RETURN = Symbol('return');

    class LoginScriptInterpreter {
        constructor(builtins, limits) {
            this.constants = builtins.constants ?? {};
            this.functions = builtins.functions ?? {};
            this.maxSteps = limits.maxSteps ?? MAX_STEPS;
            this.deadline = Date.now() + (limits.maxDurationMs ?? MAX_DURATION_MS);
            this.maxDurationMs = limits.maxDurationMs ?? MAX_DURATION_MS;
            this.steps = 0;
        }

        async run(program) {
            await this.executeStatements(program.body, new LoginScriptScope());
        }

        countStep(node) {
            this.steps++;
            if (this.steps > this.maxSteps) {
                throw new LoginScriptError(`The script ran more than ${this.maxSteps} steps. Is there an endless loop?`, node.position);
            }
            if (Date.now() > this.deadline) {
                throw new LoginScriptError(`The script ran longer than ${this.maxDurationMs / 1000} seconds.`, node.position);
            }
        }

        async executeStatements(statements, scope) {
            for (const statement of statements) {
                const signal = await this.execute(statement, scope);
                if (signal) {
                    return signal;
                }
            }
            return undefined;
        }

        async execute(node, scope) {
            this.countStep(node);
            switch (node.type) {
            case 'Block':
                return this.executeStatements(node.body, new LoginScriptScope(scope));
            case 'Declaration':
                scope.declare(node.name, node.init ? await this.evaluate(node.init, scope) : null, node.isConstant, node.position);
                return undefined;
            case 'Assignment':
                await this.assign(node, scope);
                return undefined;
            case 'ExpressionStatement':
                await this.evaluate(node.expression, scope);
                return undefined;
            case 'If':
                return this.executeIf(node, scope);
            case 'While':
                return this.executeWhile(node, scope);
            case 'For':
                return this.executeFor(node, scope);
            case 'ForOf':
                return this.executeForOf(node, scope);
            case 'Break':
                return BREAK;
            case 'Continue':
                return CONTINUE;
            case 'Return':
                return RETURN;
            default:
                throw new LoginScriptError(`Unknown statement ${node.type}.`, node.position);
            }
        }

        async assign(node, scope) {
            const binding = scope.findBinding(node.name);
            if (!binding) {
                const reason = builtinByName.has(node.name) ? `"${node.name}" is a built-in name and cannot be changed.` : `Unknown variable "${node.name}".`;
                throw new LoginScriptError(reason, node.position);
            }
            if (binding.isConstant) {
                throw new LoginScriptError(`"${node.name}" is a const and cannot be changed. Declare it with let.`, node.position);
            }

            const value = await this.evaluate(node.value, scope);
            binding.value = node.operator === '='
                ? value
                : this.applyBinary(node.operator.slice(0, 1), binding.value, value, node);
        }

        async executeIf(node, scope) {
            if (this.isTruthy(await this.evaluate(node.test, scope))) {
                return this.execute(node.consequent, scope);
            }
            return node.alternate ? this.execute(node.alternate, scope) : undefined;
        }

        async executeWhile(node, scope) {
            while (this.isTruthy(await this.evaluate(node.test, scope))) {
                const signal = await this.execute(node.body, scope);
                if (signal === BREAK || signal === RETURN) {
                    return signal === RETURN ? RETURN : undefined;
                }
                this.countStep(node);
            }
            return undefined;
        }

        async executeFor(node, scope) {
            const loopScope = new LoginScriptScope(scope);
            if (node.init) {
                await this.execute(node.init, loopScope);
            }

            while (!node.test || this.isTruthy(await this.evaluate(node.test, loopScope))) {
                const signal = await this.execute(node.body, loopScope);
                if (signal === BREAK || signal === RETURN) {
                    return signal === RETURN ? RETURN : undefined;
                }
                if (node.update) {
                    await this.execute(node.update, loopScope);
                }
                this.countStep(node);
            }
            return undefined;
        }

        async executeForOf(node, scope) {
            const iterable = await this.evaluate(node.iterable, scope);
            if (typeof iterable !== 'string' && !Array.isArray(iterable)) {
                throw new LoginScriptError(`for...of needs a list or text, but got ${this.describeType(iterable)}.`, node.iterable.position);
            }

            for (const item of iterable) {
                const iterationScope = new LoginScriptScope(scope);
                iterationScope.declare(node.name, item, node.isConstant, node.position);
                const signal = await this.execute(node.body, iterationScope);
                if (signal === BREAK || signal === RETURN) {
                    return signal === RETURN ? RETURN : undefined;
                }
            }
            return undefined;
        }

        async evaluate(node, scope) {
            this.countStep(node);
            switch (node.type) {
            case 'Literal':
                return node.value;
            case 'Template':
                return this.evaluateTemplate(node, scope);
            case 'List':
                return this.evaluateList(node, scope);
            case 'Name':
                return this.evaluateName(node, scope);
            case 'Call':
                return this.evaluateCall(node, scope);
            case 'Length':
                return this.evaluateLength(node, scope);
            case 'Index':
                return this.evaluateIndex(node, scope);
            case 'Unary':
                return this.applyUnary(node.operator, await this.evaluate(node.argument, scope), node);
            case 'Binary':
                return this.evaluateBinary(node, scope);
            case 'Conditional':
                return this.isTruthy(await this.evaluate(node.test, scope))
                    ? this.evaluate(node.consequent, scope)
                    : this.evaluate(node.alternate, scope);
            default:
                throw new LoginScriptError(`Unknown expression ${node.type}.`, node.position);
            }
        }

        async evaluateTemplate(node, scope) {
            let text = node.texts[0];
            for (let i = 0; i < node.expressions.length; i++) {
                const value = await this.evaluate(node.expressions[i], scope);
                text += this.toText(value, node.expressions[i]) + node.texts[i + 1];
            }
            return text;
        }

        async evaluateList(node, scope) {
            const items = [];
            for (const item of node.items) {
                items.push(await this.evaluate(item, scope));
            }
            return Object.freeze(items);
        }

        evaluateName(node, scope) {
            const binding = scope.findBinding(node.value);
            if (binding) {
                return binding.value;
            }
            if (Object.hasOwn(this.constants, node.value)) {
                return this.constants[node.value];
            }
            if (Object.hasOwn(this.functions, node.value)) {
                throw new LoginScriptError(`"${node.value}" is a function. Call it like ${node.value}(...).`, node.position);
            }
            throw new LoginScriptError(`Unknown name "${node.value}".`, node.position);
        }

        async evaluateCall(node, scope) {
            if (!Object.hasOwn(this.functions, node.name)) {
                const reason = Object.hasOwn(this.constants, node.name) ? `"${node.name}" is not a function.` : `Unknown function "${node.name}".`;
                throw new LoginScriptError(reason, node.position);
            }

            const args = [];
            for (const arg of node.args) {
                args.push(await this.evaluate(arg, scope));
            }
            this.requireArgumentCount(node, args);

            try {
                const value = await this.functions[node.name](...args);
                return this.requireScriptValue(value, node);
            } catch (err) {
                throw this.toCallError(err, node);
            }
        }

        requireArgumentCount(node, args) {
            const params = builtinByName.get(node.name)?.params ?? [];
            const isVariadic = params.some(it => it.startsWith('...'));
            const required = params.filter(it => !it.endsWith('?') && !it.startsWith('...')).length;
            const allowed = isVariadic ? Infinity : params.length;
            if (args.length < required || args.length > allowed) {
                throw new LoginScriptError(`${node.name}(${params.join(', ')}) got ${args.length} argument(s).`, node.position);
            }
        }

        requireScriptValue(value, node) {
            if (value === undefined || value === null) {
                return null;
            }
            if ([ 'string', 'boolean' ].includes(typeof value) || value instanceof LoginScriptElement) {
                return value;
            }
            if (typeof value === 'number' && Number.isFinite(value)) {
                return value;
            }
            if (Array.isArray(value)) {
                return Object.freeze(value.map(it => this.requireScriptValue(it, node)));
            }
            throw new LoginScriptError(`${node.name}() returned a value scripts cannot use.`, node.position);
        }

        toCallError(err, node) {
            if (err instanceof LoginScriptError && err.position) {
                return err;
            }
            const reason = err instanceof LoginScriptError ? err.reason : `unexpected error: ${err?.message ?? err}`;
            return new LoginScriptError(`${node.name}(): ${reason}`, node.position);
        }

        async evaluateLength(node, scope) {
            const object = await this.evaluate(node.object, scope);
            if (typeof object !== 'string' && !Array.isArray(object)) {
                throw new LoginScriptError(`.length needs a list or text, but got ${this.describeType(object)}.`, node.position);
            }
            return object.length;
        }

        async evaluateIndex(node, scope) {
            const object = await this.evaluate(node.object, scope);
            const index = await this.evaluate(node.index, scope);
            if (typeof object !== 'string' && !Array.isArray(object)) {
                throw new LoginScriptError(`[ ] needs a list or text, but got ${this.describeType(object)}.`, node.position);
            }
            if (!Number.isInteger(index)) {
                throw new LoginScriptError(`The index must be a whole number, but got ${this.describeType(index)}.`, node.index.position);
            }
            if (index < 0 || index >= object.length) {
                const kind = typeof object === 'string' ? 'text' : 'list';
                throw new LoginScriptError(`Index ${index} is outside the ${kind} of length ${object.length}.`, node.index.position);
            }
            return object[index];
        }

        async evaluateBinary(node, scope) {
            const left = await this.evaluate(node.left, scope);
            if (node.operator === '&&') {
                return this.isTruthy(left) ? this.evaluate(node.right, scope) : left;
            }
            if (node.operator === '||') {
                return this.isTruthy(left) ? left : this.evaluate(node.right, scope);
            }
            if (node.operator === '??') {
                return left === null ? this.evaluate(node.right, scope) : left;
            }
            return this.applyBinary(node.operator, left, await this.evaluate(node.right, scope), node);
        }

        applyBinary(operator, left, right, node) {
            switch (operator) {
            case '==':
            case '===':
                return left === right;
            case '!=':
            case '!==':
                return left !== right;
            case '+':
                return this.add(left, right, node);
            case '-':
                return this.requireNumber(left, node) - this.requireNumber(right, node);
            case '*':
                return this.requireNumber(left, node) * this.requireNumber(right, node);
            case '/':
                return this.requireNumber(left, node) / this.requireNumber(right, node);
            case '%':
                return this.requireNumber(left, node) % this.requireNumber(right, node);
            default:
                return this.compare(operator, left, right, node);
            }
        }

        add(left, right, node) {
            if (typeof left === 'string' || typeof right === 'string') {
                return this.toText(left, node) + this.toText(right, node);
            }
            return this.requireNumber(left, node) + this.requireNumber(right, node);
        }

        compare(operator, left, right, node) {
            const bothNumbers = typeof left === 'number' && typeof right === 'number';
            const bothTexts = typeof left === 'string' && typeof right === 'string';
            if (!bothNumbers && !bothTexts) {
                throw new LoginScriptError(`"${operator}" compares two numbers or two texts, but got ${this.describeType(left)} and ${this.describeType(right)}.`, node.position);
            }

            const comparisons = { '<': left < right, '<=': left <= right, '>': left > right, '>=': left >= right };
            return comparisons[operator];
        }

        applyUnary(operator, value, node) {
            if (operator === '!') {
                return !this.isTruthy(value);
            }
            const number = this.requireNumber(value, node);
            return operator === '-' ? -number : number;
        }

        requireNumber(value, node) {
            if (typeof value !== 'number') {
                throw new LoginScriptError(`Expected a number, but got ${this.describeType(value)}. Use toNumber() for text.`, node.position);
            }
            return value;
        }

        toText(value, node) {
            if (value instanceof LoginScriptElement || Array.isArray(value)) {
                throw new LoginScriptError(`Cannot turn ${this.describeType(value)} into text.`, node.position);
            }
            return String(value);
        }

        isTruthy(value) {
            return Boolean(value);
        }

        describeType(value) {
            if (value === null) {
                return 'null';
            }
            if (value instanceof LoginScriptElement) {
                return 'an element';
            }
            if (Array.isArray(value)) {
                return 'a list';
            }
            return { 'string': 'text', 'number': 'a number', 'boolean': 'true/false' }[typeof value] ?? 'an unknown value';
        }
    }

    const run = async function(program, builtins, limits = {}) {
        await new LoginScriptInterpreter(builtins, limits).run(program);
    };

    return {
        BUILTINS,
        EXAMPLE,
        ScriptElement: LoginScriptElement,
        ScriptError: LoginScriptError,
        findProblems,
        findUrlPatternProblems,
        matchesUrl,
        parse,
        run,
    };
})();

// Exports for tests
if (typeof module === 'object') {
    module.exports = kpxcLoginScriptLanguage;
}

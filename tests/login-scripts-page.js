'use strict';

// A two-step bank login: customer number first, then a masked password asking for characters 1, 5, 7, 8 and 9
const ASKED_INDEXES = [ 0, 4, 6, 7, 8 ];

const createMaskedInputs = function() {
    const container = document.querySelector('#password');
    for (let i = 0; i < 16; i++) {
        const input = document.createElement('input');
        input.type = 'password';
        input.maxLength = 1;
        input.id = `ce36c676-87dd-4c77-3e71-3e03fb98471a-${i}`;
        input.disabled = !ASKED_INDEXES.includes(i);
        input.addEventListener('input', () => updateLoginButton());
        container.append(input);
    }
};

const findActiveInputs = function() {
    return Array.from(document.querySelectorAll('#password input:not([disabled])'));
};

const updateLoginButton = function() {
    document.querySelector('#login').disabled = findActiveInputs().some(it => it.value.length !== 1);
};

const showPasswordStepLater = function() {
    if (!document.querySelector('#customer').value) {
        return;
    }

    document.querySelector('#customerStep').hidden = true;
    setTimeout(() => {
        document.querySelector('#passwordStep').hidden = false;
    }, 300);
};

const logIn = function() {
    const characters = findActiveInputs().map(it => it.value).join('');
    document.body.dataset.loggedIn = `${document.querySelector('#customer').value}:${characters}`;
};

createMaskedInputs();
document.querySelector('#next').addEventListener('click', () => showPasswordStepLater());
document.querySelector('#login').addEventListener('click', () => logIn());

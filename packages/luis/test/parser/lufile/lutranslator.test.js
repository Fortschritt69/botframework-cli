/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
var chai = require('chai');
var assert = chai.assert;
const testData = require('./../../fixtures/testcases/translate-testcase-data');
const translate = require('./../../../src/parser/lufile/translate-helpers');
const retCode = require('./../../../src/parser/lufile/enums/CLI-errors');
const helpers = require('./../../../src/parser/lufile/helpers');
const NEWLINE = require('os').EOL;
const TRANSLATE_KEY2 = process.env.TRANSLATOR_KEY;
const TRANSLATE_KEY = null;

describe('With the parseAndTranslate method', function() {
    it('Translating comments can be skipped', function(done) {
        translate.parseAndTranslate(`> This is a comment`, TRANSLATE_KEY, testData.tests.intentsAndUtterancesNC.langCode, '', false, false, false)
            .then(function(res) {
                assert.equal(helpers.sanitizeNewLines(res), helpers.sanitizeNewLines(`> This is a comment
`));
                done();
            })
            .catch(err => done(err));
    });

    
    xit('QnA content is translated correctly', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.qna.luFile, TRANSLATE_KEY, testData.tests.qna.langCode, '', false, false, false)
            .then(function(res) {
                assert.equal(helpers.sanitizeNewLines(res), helpers.sanitizeNewLines(testData.tests.qna.translatedContent));
                done();
            })
            .catch(err => done(err))
    });

    
    xit('Phrase list entity references are translated correctly', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.phraseList.luFile, TRANSLATE_KEY, testData.tests.phraseList.langCode, '', false, false, false)
            .then(function(res) {
                assert.equal(helpers.sanitizeNewLines(res), helpers.sanitizeNewLines(testData.tests.phraseList.translatedContent));
                done();
            })
            .catch(err => done(err))
    });

    it('Bad lu file input throws', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.badLu.luFile, TRANSLATE_KEY, testData.tests.badLu.langCode, '', false, false, false)
            .then(res => done(res)) 
            .catch(function(err) {
                assert.equal(err.errCode, retCode.errorCode.INVALID_INPUT_FILE);
                done();
            })
    });

    it('References can be skipped from being translated', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.fileRef.luFile, TRANSLATE_KEY, testData.tests.fileRef.langCode, '', false, false, false)
            .then(function(res) {
                assert.equal(helpers.sanitizeNewLines(res), helpers.sanitizeNewLines(testData.tests.fileRef.luFile + NEWLINE));
                done();
            })
            .catch(err => done(err))
    });

    it('Invalid key throws', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(`# Greeting
-hi
`, TRANSLATE_KEY + '2', testData.tests.badLu.langCode, '', false, false, false)
            .then(function(res) {
                done(res);
            }) 
            .catch(function(err) {
                assert.equal(err.errCode, retCode.errorCode.TRANSLATE_SERVICE_FAIL);
                done();
            })
    }); 

    it('Invalid key with comments throws', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(`> test comment
`, TRANSLATE_KEY + '2', testData.tests.badLu.langCode, '', true, false, false)
            .then(function(res) {
                done(res);
            }) 
            .catch(function(err) {
                assert.equal(err.errCode, retCode.errorCode.TRANSLATE_SERVICE_FAIL);
                done();
            })
    });

    it('Nested entity references throws', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(`# Greeting
        - hi {userName = foo {firstName = bar}}
`, TRANSLATE_KEY, testData.tests.badLu.langCode, '', false, false, true)
            .then(function(res) {
                done(res);
            }) 
            .catch(function(err) {
                assert.equal(err.errCode, retCode.errorCode.INVALID_INPUT);
                done();
            })
    });
    
    it('Labelled entity values are translated correctly', function (done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.labelledEntityValue.luFile, TRANSLATE_KEY, testData.tests.labelledEntityValue.langCode, '', false, true, false)
            .then(function (res) {
                assert.equal(helpers.sanitizeNewLines(res), helpers.sanitizeNewLines(testData.tests.labelledEntityValue.translatedContent));
                done();
            })
            .catch(err => done(err))
    });
    
    it('Invalid key with QnA throws', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(`# ? Greeting
        - hi
`, TRANSLATE_KEY + '2', testData.tests.badLu.langCode, '', false, false, false)
            .then(function(res) {
                done(res);
            }) 
            .catch(function(err) {
                assert.equal(err.errCode, retCode.errorCode.TRANSLATE_SERVICE_FAIL);
                done();
            })
    });

    it('Intent only is handled correctly', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(`# Greeting
`, TRANSLATE_KEY, testData.tests.badLu.langCode, '', false, false, true)
            .then(function() {
                done();
            }) 
            .catch(function() {
                done('Test Fail! Threw when not expected');
            })
    });

    

    it('References are translated correctly', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.fileRef.luFile, TRANSLATE_KEY, testData.tests.fileRef.langCode, '', false, true, false)
            .then(function(res) {
                assert.equal(helpers.sanitizeNewLines(res), helpers.sanitizeNewLines(testData.tests.fileRef.translatedContent + NEWLINE));    
                done();
            })
            .catch(err => done(err))
    });

    

    it('All entity types are translated correctly', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.allEntities.luFile, TRANSLATE_KEY, testData.tests.allEntities.langCode, '', false, false, false)
            .then(function(res) {
                assert.equal(helpers.sanitizeNewLines(res), helpers.sanitizeNewLines(testData.tests.allEntities.translatedContent));
                done();
            })
            .catch(err => done(err))
    });

    xit('Intents and utterances are translated correctly', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(testData.tests.intentsAndUtterances.luFile, TRANSLATE_KEY, testData.tests.intentsAndUtterances.langCode, 'en-us', true, false, true)
            .then(function(res) {
                assert.equal(res, helpers.sanitizeNewLines(testData.tests.intentsAndUtterances.translatedContent));
                done();
            })
            .catch(err => done(err))
    }); 

    it('QnA is translated correctly', function(done) {
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(`# ? hello
\`\`\`markdown`, TRANSLATE_KEY, 'de', 'en-us', true, false, true)
            .then(function(res) {
                assert.equal('# ? Hallo' + NEWLINE + '```markdown' + NEWLINE, res);
                done();
            })
            .catch(err => done(err))
    }); 

    it('BF CLI #121 - For list entities, normalized value is added as synonym', function(done){
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        translate.parseAndTranslate(`$ simple : one =`, TRANSLATE_KEY, 'fr-fr', 'en-us', true, false, true)
            .then(function(res) {
                assert.equal('$ simple : one =' + NEWLINE + '- un' + NEWLINE, res);
                done();
            })
            .catch(err => done(err))
    });

    it('Translate for new entity type is handled correctly', function(done){
        if (!TRANSLATE_KEY) {
            this.skip();
        }
        let luFile = `
@ simple s1 sr1
@ phraselist pl1 = 
    - cheese
    - tomato
    - potato
@ list l1 hasRoles lr1,lr2 = 
- one :
    - two
    - three
- four :
    - five
    - six
`;

        let trRes = `
@ simple s1 sr1
@ phraselist pl1 =
        - fromage
        - tomate
        - pomme de terre
@ list l1 hasRoles lr1,lr2 =
        - one:
            - un
            - deux
            - trois
        - four:
            - quatre
            - cinq
            - six
`;
        translate.parseAndTranslate(luFile, TRANSLATE_KEY, 'fr-fr', 'en-us', true, false, true)
            .then(res => {
                assert.equal(res.replace(/[\r\n\t ]/g, ''), trRes.replace(/[\r\n\t ]/g, ''));
                done();
            })
            .catch(err => done(err))
    })
    
});
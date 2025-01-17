#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
require('./utils');
const LUISObjNameEnum = require('./enums/luisobjenum');
const PARSERCONSTS = require('./enums/parserconsts');
const builtInTypes = require('./enums/luisbuiltintypes');
const helpers = require('./helpers');
const chalk = require('chalk');
const url = require('url');
const retCode = require('./enums/CLI-errors');
const parserObj = require('./classes/parserObject');
const qnaListObj = require('./classes/qnaList');
const qnaMetaDataObj = require('./classes/qnaMetaData');
const helperClass = require('./classes/hclasses');
const deepEqual = require('deep-equal');
const qna = require('./classes/qna');
const exception = require('./classes/exception');
const qnaAlterations = require('./classes/qnaAlterations');
const fetch = require('node-fetch');
const qnaFile = require('./classes/qnaFiles');
const fileToParse = require('./classes/filesToParse');
const luParser = require('./luParser');
const DiagnosticSeverity = require('./diagnostic').DiagnosticSeverity;
const BuildDiagnostic = require('./diagnostic').BuildDiagnostic;
const EntityTypeEnum = require('./enums/lusiEntityTypes');
const parseFileContentsModule = {
    /**
     * Main parser code to parse current file contents into LUIS and QNA sections.
     * @param {string} fileContent current file content
     * @param {boolean} log indicates if we need verbose logging.
     * @param {string} locale LUIS locale code
     * @returns {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
     * @throws {exception} Throws on errors. exception object includes errCode and text. 
     */
    parseFile: async function (fileContent, log, locale) {
        fileContent = helpers.sanitizeNewLines(fileContent);
        let parsedContent = new parserObj();
        await parseLuAndQnaWithAntlr(parsedContent, fileContent.toString(), log, locale);

        return parsedContent;
    },
    /**
     * Helper function to add an item to collection if it does not exist
     * @param {object} collection contents of the current collection
     * @param {LUISObjNameEnum} type item type
     * @param {object} value value of the current item to examine and add
     * @returns {void} nothing
     */
    addItemIfNotPresent: function (collection, type, value) {
        let hasValue = false;
        for (let i in collection[type]) {
            if (collection[type][i].name === value) {
                hasValue = true;
                break;
            }
        }
        if (!hasValue) {
            let itemObj = {};
            itemObj.name = value;
            if (type == LUISObjNameEnum.PATTERNANYENTITY) {
                itemObj.explicitList = [];
            }
            if (type !== LUISObjNameEnum.INTENT) {
                itemObj.roles = [];
            }
            collection[type].push(itemObj);
        }
    },
    /**
     * Helper function to add an item to collection if it does not exist
     * @param {object} collection contents of the current collection
     * @param {LUISObjNameEnum} type item type
     * @param {object} value value of the current item to examine and add
     * @param {string []} roles possible roles to add to the item
     * @returns {void} nothing
     */
    addItemOrRoleIfNotPresent: function (collection, type, value, roles) {
        let existingItem = collection[type].filter(item => item.name == value);
        if (existingItem.length !== 0) {
            // see if the role exists and if so, merge
            mergeRoles(existingItem[0].roles, roles);
        } else {
            let itemObj = {};
            itemObj.name = value;
            if (type == LUISObjNameEnum.PATTERNANYENTITY) {
                itemObj.explicitList = [];
            }
            if (type == LUISObjNameEnum.COMPOSITES) {
                itemObj.children = [];
            }
            if (type !== LUISObjNameEnum.INTENT) {
                itemObj.roles = roles;
            }
            collection[type].push(itemObj);
        }
    }
};

/**
 * Main parser code to parse current file contents into LUIS and QNA sections.
 * @param {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {string} fileContent current file content
 * @param {boolean} log indicates if we need verbose logging.
 * @param {string} locale LUIS locale code
 * @throws {exception} Throws on errors. exception object includes errCode and text.
 */
const parseLuAndQnaWithAntlr = async function (parsedContent, fileContent, log, locale) {
    fileContent = helpers.sanitizeNewLines(fileContent);
    let luResource = luParser.parse(fileContent);

    if (luResource.Errors && luResource.Errors.length > 0) {
        if (log) {
            var warns = luResource.Errors.filter(error => (error && error.Severity && error.Severity === DiagnosticSeverity.WARN));
            if (warns.length > 0) {
                process.stdout.write(warns.map(warn => warn.toString()).join('\n').concat('\n'));
            }
        }

        var errors = luResource.Errors.filter(error => (error && error.Severity && error.Severity === DiagnosticSeverity.ERROR));
        if (errors.length > 0) {
            throw (new exception(retCode.errorCode.INVALID_LINE, errors.map(error => error.toString()).join('\n')));
        }
    }

    // parse reference section
    await parseAndHandleReference(parsedContent, luResource);

    // parse entity definition v2 section
    parseAndHandleEntityV2(parsedContent, luResource, log, locale);

    // parse intent section
    parseAndHandleIntent(parsedContent, luResource);

    // parse entity section
    parseAndHandleEntity(parsedContent, luResource, log, locale);

    // parse qna section
    parseAndHandleQna(parsedContent, luResource);

    // parse model info section
    parseAndHandleModelInfo(parsedContent, luResource, log);
}

/**
 * Reference parser code to parse reference section.
 * @param {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {LUResouce} luResource resources extracted from lu file content
 * @throws {exception} Throws on errors. exception object includes errCode and text.
 */
const parseAndHandleReference = async function (parsedContent, luResource) {
    // handle reference
    let luImports = luResource.Imports;
    if (luImports && luImports.length > 0) {
        for (const luImport of luImports) {
            let linkValueText = luImport.Description.replace('[', '').replace(']', '');
            let linkValue = luImport.Path.replace('(', '').replace(')', '');
            let parseUrl = url.parse(linkValue);
            if (parseUrl.host || parseUrl.hostname) {
                let options = { method: 'HEAD' };
                let response;
                try {
                    response = await fetch(linkValue, options);
                } catch (err) {
                    // throw, invalid URI
                    let errorMsg = `URI: "${linkValue}" appears to be invalid. Please double check the URI or re-try this parse when you are connected to the internet.`;
                    let error = BuildDiagnostic({
                        message: errorMsg,
                        context: luImport.ParseTree
                    })

                    throw (new exception(retCode.errorCode.INVALID_URI, error.toString()));
                }

                if (!response.ok) {
                    let errorMsg = `URI: "${linkValue}" appears to be invalid. Please double check the URI or re-try this parse when you are connected to the internet.`;
                    let error = BuildDiagnostic({
                        message: errorMsg,
                        context: luImport.ParseTree
                    })

                    throw (new exception(retCode.errorCode.INVALID_URI, error.toString()));
                }

                let contentType = response.headers.get('content-type');
                if (!contentType.includes('text/html')) {
                    parsedContent.qnaJsonStructure.files.push(new qnaFile(linkValue, linkValueText));
                } else {
                    parsedContent.qnaJsonStructure.urls.push(linkValue);
                }

            } else {
                parsedContent.additionalFilesToParse.push(new fileToParse(linkValue));
            }
        }
    }
}
/**
 * Helper function to handle @ reference in patterns
 * @param {String} utterance 
 * @param {String []} entitiesFound 
 * @param {Object []} flatEntityAndRoles 
 */
const handleAtForPattern = function(utterance, entitiesFound, flatEntityAndRoles) {
    if (utterance.match(/{@/g)) {
        utterance = utterance.replace(/{@/g, '{');
        entitiesFound.forEach(entity => {
            if (entity.entity.match(/^@/g)) {
                entity = handleAtPrefix(entity, flatEntityAndRoles);
                if (entity.entity && entity.role) {
                    utterance = utterance.replace(`{${entity.role}}`, `{${entity.entity}:${entity.role}}`);
                }
            }
        });
    }
    return utterance;
}

/**
 * Helper function to handle @ entity or @ role reference in utterances.
 * @param {Object} entity 
 * @param {Object []} flatEntityAndRoles 
 */
const handleAtPrefix = function(entity, flatEntityAndRoles) {
    if (entity.entity.match(/^@/g)) {
        entity.entity = entity.entity.replace(/^@/g, '').trim();
        if (flatEntityAndRoles) {
            // find the entity as a match by name
            let entityMatch = flatEntityAndRoles.find(item => item.entityName == entity.entity);
            if (entityMatch !== undefined) {
                return entity;
            }
            // find the entity as a match by role
            let roleMatch = flatEntityAndRoles.find(item => item.roles.includes(entity.entity));
            if (roleMatch !== undefined) {
                // we have a role match. 
                entity.role = entity.entity;
                entity.entity = roleMatch.name;
                return entity;
            }
        }
    }
    
    return entity;
}
/**
 * Intent parser code to parse intent section.
 * @param {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {LUResouce} luResource resources extracted from lu file content
 * @throws {exception} Throws on errors. exception object includes errCode and text.
 */
const parseAndHandleIntent = function (parsedContent, luResource) {
    // handle intent
    let intents = luResource.Intents;
    if (intents && intents.length > 0) {
        for (const intent of intents) {
            let intentName = intent.Name;
            // insert only if the intent is not already present.
            addItemIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.INTENT, intentName);
            for (const utteranceAndEntities of intent.UtteranceAndEntitiesMap) {
                // add utterance
                let utterance = utteranceAndEntities.utterance.trim();
                // Fix for BF-CLI #122. 
                // Ensure only links are detected and passed on to be parsed.
                if (helpers.isUtteranceLinkRef(utterance || '')) {
                    let parsedLinkUriInUtterance = helpers.parseLinkURI(utterance);
                    // examine and add these to filestoparse list.
                    parsedContent.additionalFilesToParse.push(new fileToParse(parsedLinkUriInUtterance.luFile, false));
                }

                if (utteranceAndEntities.entities.length > 0) {
                    let entitiesFound = utteranceAndEntities.entities;
                    let havePatternAnyEntity = entitiesFound.find(item => item.type == LUISObjNameEnum.PATTERNANYENTITY);
                    if (havePatternAnyEntity !== undefined) {
                        utterance = handleAtForPattern(utterance, entitiesFound, parsedContent.LUISJsonStructure.flatListOfEntityAndRoles);
                        let mixedEntity = entitiesFound.filter(item => item.type != LUISObjNameEnum.PATTERNANYENTITY);
                        if (mixedEntity.length !== 0) {
                            let errorMsg = `Utterance "${utteranceAndEntities.context.getText()}" has mix of entites with labelled values and ones without. Please update utterance to either include labelled values for all entities or remove labelled values from all entities.`;
                            let error = BuildDiagnostic({
                                message: errorMsg,
                                context: utteranceAndEntities.context
                            })

                            throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
                        }

                        let newPattern = new helperClass.pattern(utterance, intentName);
                        if (!parsedContent.LUISJsonStructure.patterns.find(item => deepEqual(item, newPattern))) {
                            parsedContent.LUISJsonStructure.patterns.push(newPattern);
                        }

                        // add all entities to pattern.Any only if they do not have another type.
                        entitiesFound.forEach(entity => {
                            let simpleEntityInMaster = parsedContent.LUISJsonStructure.entities.find(item => item.name == entity.entity);
                            if (simpleEntityInMaster && entity.role) {
                                addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.ENTITIES, entity.entity, [entity.role.trim()]);
                            }
                            let compositeInMaster = parsedContent.LUISJsonStructure.composites.find(item => item.name == entity.entity);
                            if (compositeInMaster && entity.role) {
                                addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.COMPOSITES, entity.entity, [entity.role.trim()]);
                            }
                            let listEntityInMaster = parsedContent.LUISJsonStructure.closedLists.find(item => item.name == entity.entity);
                            if (listEntityInMaster && entity.role) {
                                addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.CLOSEDLISTS, entity.entity, [entity.role.trim()]);
                            }
                            let regexEntityInMaster = parsedContent.LUISJsonStructure.regex_entities.find(item => item.name == entity.entity);
                            if (regexEntityInMaster && entity.role) {
                                addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.REGEX, entity.entity, [entity.role.trim()]);
                            }
                            let prebuiltInMaster = parsedContent.LUISJsonStructure.prebuiltEntities.find(item => item.name == entity.entity);
                            if (prebuiltInMaster && entity.role) {
                                addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.PREBUILT, entity.entity, [entity.role.trim()]);
                            }
                            if (!simpleEntityInMaster &&
                                !compositeInMaster &&
                                !listEntityInMaster &&
                                !regexEntityInMaster &&
                                !prebuiltInMaster) {
                                if (entity.role && entity.role !== '') {
                                    addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.PATTERNANYENTITY, entity.entity, [entity.role.trim()])
                                } else {
                                    addItemIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.PATTERNANYENTITY, entity.entity);
                                }
                            }                             
                        });
                    } else {
                        entitiesFound.forEach(entity => {
                            // handle at prefix
                            entity = handleAtPrefix(entity, parsedContent.LUISJsonStructure.flatListOfEntityAndRoles);
                            // throw an error if phraselist entity is explicitly labelled in an utterance
                            let nonAllowedPhrseListEntityInUtterance = (parsedContent.LUISJsonStructure.model_features || []).find(item => item.name == entity.entity);
                            if (nonAllowedPhrseListEntityInUtterance !== undefined) {
                                // Fix for #1137
                                // Phrase list entity can have the same name as other entity types. Only throw if the phrase list has no other type definition and is labelled in an utterance.
                                let otherEntities = (parsedContent.LUISJsonStructure.entities || []).concat(
                                    (parsedContent.LUISJsonStructure.prebuiltEntities || []),
                                    (parsedContent.LUISJsonStructure.closedLists || []),
                                    (parsedContent.LUISJsonStructure.regex_entities || []),
                                    (parsedContent.LUISJsonStructure.model_features || []),
                                    (parsedContent.LUISJsonStructure.composites || [])
                                );
                                if ((otherEntities || []).find(item => item.name == entity.entity) === undefined) {
                                    let errorMsg = `Utterance "${utterance}" has invalid reference to Phrase List entity "${nonAllowedPhrseListEntityInUtterance.name}". Phrase list entities cannot be given an explicit labelled value.`;
                                    let error = BuildDiagnostic({
                                        message: errorMsg,
                                        context: utteranceAndEntities.context
                                    });

                                    throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
                                }
                            }

                            // only add this entity if it has not already been defined as composite, list, prebuilt, regex
                            let compositeExists = (parsedContent.LUISJsonStructure.composites || []).find(item => item.name == entity.entity);
                            let listExists = (parsedContent.LUISJsonStructure.closedLists || []).find(item => item.name == entity.entity);
                            let prebuiltExists = (parsedContent.LUISJsonStructure.prebuiltEntities || []).find(item => item.name == entity.entity);
                            let regexExists = (parsedContent.LUISJsonStructure.regex_entities || []).find(item => item.name == entity.entity);
                            let patternAnyExists = (parsedContent.LUISJsonStructure.patternAnyEntities || []).find(item => item.name == entity.entity);
                            if (compositeExists === undefined && listExists === undefined && prebuiltExists === undefined && regexExists === undefined && patternAnyExists === undefined) {
                                if (entity.role && entity.role !== '') {
                                    addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.ENTITIES, entity.entity, [entity.role.trim()]);
                                } else {
                                    addItemIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.ENTITIES, entity.entity)
                                }
                            } else {
                                if (compositeExists !== undefined) {
                                    if (entity.role) {
                                        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.COMPOSITES, entity.entity, [entity.role.trim()]);
                                    }
                                } else if (listExists !== undefined) {
                                    if (entity.role) {
                                        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.CLOSEDLISTS, entity.entity, [entity.role.trim()]);
                                    } else {
                                        let errorMsg = `${entity.entity} has been defined as a LIST entity type. It cannot be explicitly included in a labelled utterance unless the label includes a role.`;
                                        let error = BuildDiagnostic({
                                            message: errorMsg,
                                            context: utteranceAndEntities.context
                                        });

                                        throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
                                    }
                                } else if (prebuiltExists !== undefined) {
                                    if (entity.role) {
                                        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.PREBUILT, entity.entity, [entity.role.trim()]);
                                    } else {
                                        let errorMsg = `${entity.entity} has been defined as a PREBUILT entity type. It cannot be explicitly included in a labelled utterance unless the label includes a role.`;
                                        let error = BuildDiagnostic({
                                            message: errorMsg,
                                            context: utteranceAndEntities.context
                                        });

                                        throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
                                    }
                                } else if (regexExists !== undefined) {
                                    if (entity.role) {
                                        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.REGEX, entity.entity, [entity.role.trim()]);
                                    } else {
                                        let errorMsg = `${entity.entity} has been defined as a Regex entity type. It cannot be explicitly included in a labelled utterance unless the label includes a role.`;
                                        let error = BuildDiagnostic({
                                            message: errorMsg,
                                            context: utteranceAndEntities.context
                                        });

                                        throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
                                    }
                                } else if (patternAnyExists !== undefined) {
                                    if (entity.value != '') {
                                        // Verify and add this as simple entity.
                                        let roles = (entity.role && entity.role.trim() !== "") ? [entity.role.trim()] : [];
                                        patternAnyExists.roles.forEach(role => roles.push(role));
                                        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.ENTITIES, entity.entity, roles);
                                        let patternAnyIdx = -1;
                                        (parsedContent.LUISJsonStructure.patternAnyEntities || []).find((item, idx) => {
                                            if (item.name === entity.entity) {
                                                patternAnyIdx = idx;
                                                return true;
                                            }
                                            return false;
                                        });
                                        // delete pattern any entity
                                        if (patternAnyIdx > -1) parsedContent.LUISJsonStructure.patternAnyEntities.splice(patternAnyIdx, 1);

                                    } else if (entity.role) {
                                        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.PATTERNANYENTITY, entity.entity, [entity.role.trim()]);
                                    }
                                }
                            }
                        });

                        // add utterance
                        let utteranceExists = parsedContent.LUISJsonStructure.utterances.find(item => item.text == utterance && item.intent == intentName);
                        let utteranceObject = utteranceExists || new helperClass.uttereances(utterance, intentName, []);
                        entitiesFound.forEach(item => {
                            if (item.startPos > item.endPos) {
                                let errorMsg = `No labelled value found for entity: "${item.entity}" in utterance: "${utteranceAndEntities.context.getText()}"`;
                                let error = BuildDiagnostic({
                                    message: errorMsg,
                                    context: utteranceAndEntities.context
                                })

                                throw (new exception(retCode.errorCode.MISSING_LABELLED_VALUE, error.toString()));
                            }

                            let utteranceEntity = new helperClass.utteranceEntity(item.entity, item.startPos, item.endPos);
                            if (item.role && item.role !== '') {
                                utteranceEntity.role = item.role.trim();
                            }
                            utteranceObject.entities.push(utteranceEntity)
                        });
                        if (utteranceExists === undefined) parsedContent.LUISJsonStructure.utterances.push(utteranceObject);
                    }

                } else {
                    // detect if utterance is a pattern and if so add it as a pattern
                    if (helpers.isUtterancePattern(utterance)) {
                        let patternObject = new helperClass.pattern(utterance, intentName);
                        parsedContent.LUISJsonStructure.patterns.push(patternObject);
                    } else {
                        if(parsedContent.LUISJsonStructure.utterances.find(item => item.text == utterance && item.intent == intentName) === undefined) {
                            let utteranceObject = new helperClass.uttereances(utterance, intentName, []);
                            parsedContent.LUISJsonStructure.utterances.push(utteranceObject);    
                        }
                    }
                }
            }
        }
    }
}

/**
 * Helper function to get entity type based on a name match
 * @param {String} entityName name of entity to look up type for.
 * @param {Object[]} entities collection of entities in the current application
 */
const getEntityType = function(entityName, entities) {
    let entityFound = (entities || []).find(item => item.Name == entityName);
    return entityFound ? entityFound.Type : undefined;
};

/**
 * Helper function to validate that new roles being added are unique at the application level.
 * @param {Object} parsedContent with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {String[]} roles string array of new roles to be added
 * @param {String} line current line being parsed.
 * @param {String} entityName name of the entity being added.
 */
const validateAndGetRoles = function(parsedContent, roles, line, entityName, entityType) {
    let newRoles = roles ? roles.split(',').map(item => item.trim()) : [];
    // de-dupe roles
    newRoles = [...new Set(newRoles)];
    // entity roles need to unique within the application
    if(parsedContent.LUISJsonStructure.flatListOfEntityAndRoles) {
        let matchType = '';
        // Duplicate entity names are not allowed
        // Entity name cannot be same as a role name
        let entityFound = parsedContent.LUISJsonStructure.flatListOfEntityAndRoles.find(item => {
            if (item.name === entityName && item.type !== entityType) {
                matchType = `Entity names must be unique. Duplicate definition found for "${entityName}".`;
                return true;
            } else if (item.roles.includes(entityName)) {
                matchType = `Entity name cannot be the same as a role name. Duplicate definition found for "${entityName}".`;
                return true;
            }
        })
        if (entityFound !== undefined) {
            let errorMsg = `${matchType} Prior definition - '@ ${entityFound.type} ${entityFound.name}${entityFound.roles.length > 0 ? ` hasRoles ${entityFound.roles.join(',')}` : ``}'`;
            let error = BuildDiagnostic({
                message: errorMsg,
                context: line
            })
            throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
        }
        newRoles.forEach(role => {
            let roleFound = parsedContent.LUISJsonStructure.flatListOfEntityAndRoles.find(item => item.roles.includes(role) || item.name === role);
            if (roleFound !== undefined) {
                let errorMsg = `Roles must be unique across entity types. Invalid role definition found "${entityName}". Prior definition - '@ ${roleFound.type} ${roleFound.name}${roleFound.roles.length > 0 ? ` hasRoles ${roleFound.roles.join(',')}` : ``}'`;
                let error = BuildDiagnostic({
                    message: errorMsg,
                    context: line
                })
                throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
            } 
        });

        let oldEntity = parsedContent.LUISJsonStructure.flatListOfEntityAndRoles.find(item => item.name === entityName && item.type === entityType);
        if (oldEntity !== undefined) {
            oldEntity.addRoles(newRoles);
        } else {
            parsedContent.LUISJsonStructure.flatListOfEntityAndRoles.push(new helperClass.entityAndRoles(entityName, entityType, newRoles))
        }

    } else {
        parsedContent.LUISJsonStructure.flatListOfEntityAndRoles = new Array();
        parsedContent.LUISJsonStructure.flatListOfEntityAndRoles.push(new helperClass.entityAndRoles(entityName, entityType, newRoles));
    }
    return newRoles;
};

/**
 * 
 * @param {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {LUResouce} luResource resources extracted from lu file content
 * @param {boolean} log indicates where verbose flag is set 
 * @param {String} locale current target locale
 * @throws {exception} Throws on errors. exception object includes errCode and text.
 */
const parseAndHandleEntityV2 = function (parsedContent, luResource, log, locale) {
    // handle new entity definitions.
    let entities = luResource.NewEntities;
    if (entities && entities.length > 0) {
        for (const entity of entities) {
            let entityName = entity.Name.replace(/^[\'\"]|[\'\"]$/g, "");
            let entityType = !entity.Type ? getEntityType(entity.Name, entities) : entity.Type;
            if (!entityType) {
                let errorMsg = `No type definition found for entity "${entityName}"`;
                let error = BuildDiagnostic({
                    message: errorMsg,
                    context: entity.ParseTree.newEntityLine()
                })
                throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
            };

            if (entityType === entityName) {
                let errorMsg = `Entity name "${entityName}" cannot be the same as entity type "${entityType}"`;
                let error = BuildDiagnostic({
                    message: errorMsg,
                    context: entity.ParseTree.newEntityLine()
                })
                throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
            }
            let entityRoles = validateAndGetRoles(parsedContent, entity.Roles, entity.ParseTree.newEntityLine(), entityName, entityType);
            let PAEntityRoles = RemoveDuplicatePatternAnyEntity(parsedContent, entityName, entityType, entity.ParseTree.newEntityLine());
            if (PAEntityRoles.length > 0) {
                PAEntityRoles.forEach(role => {
                    if (!entityRoles.includes(role)) entityRoles.push(role);
                })
            }
            switch(entityType) {
                case EntityTypeEnum.SIMPLE: 
                    addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.ENTITIES, entityName, entityRoles);
                    break;
                case EntityTypeEnum.COMPOSITE:
                    let candidateChildren = [];
                    if (entity.CompositeDefinition) {
                        entity.CompositeDefinition.replace(/[\[\]]/g, '').split(/[,;]/g).map(item => item.trim()).forEach(item => candidateChildren.push(item));
                    }
                    if (entity.ListBody) {
                        entity.ListBody.forEach(line => {
                            line.replace(/[\[\]]/g, '').split(/[,;]/g).map(item => item.trim()).forEach(item => candidateChildren.push(item));
                        })
                    }
                    handleComposite(parsedContent, entityName,`[${candidateChildren.join(',')}]`, entityRoles, entity.ParseTree.newEntityLine());
                    break;
                case EntityTypeEnum.LIST:
                    handleClosedList(parsedContent, entityName, entity.ListBody, entityRoles, entity.ParseTree.newEntityLine());
                    break;
                case EntityTypeEnum.PATTERNANY:
                    handlePatternAny(parsedContent, entityName, entityRoles, entity.ParseTree.newEntityLine());
                    break;
                case EntityTypeEnum.PREBUILT:
                    handlePrebuiltEntity(parsedContent, 'prebuilt', entityName, entityRoles, locale, log, entity.ParseTree.newEntityLine());
                    break;
                case EntityTypeEnum.REGEX:
                    if (entity.ListBody[0]) {
                        handleRegExEntity(parsedContent, entityName, entity.ListBody[0], entityRoles, entity.ParseTree.newEntityLine());
                    } else {
                        handleRegExEntity(parsedContent, entityName, entity.RegexDefinition, entityRoles, entity.ParseTree.newEntityLine());
                    } 
                    break;
                case EntityTypeEnum.ML:
                    break;
                case EntityTypeEnum.PHRASELIST:
                    handlePhraseList(parsedContent, entityName, undefined, entityRoles, entity.ListBody, entity.ParseTree.newEntityLine());
                default:
                    //Unknown entity type
                    break;
            }
        }
    }
};

/**
 * Helper function to handle pattern.any entity
 * @param {Object} parsedContent parsed LUIS, QnA and QnA alteration object
 * @param {String} entityName entity name
 * @param {String} entityRoles collection of entity roles
 */
const handlePatternAny = function(parsedContent, entityName, entityRoles) {
     // check if this patternAny entity is already labelled in an utterance and or added as a simple entity. if so, throw an error.
     try {
        let rolesImport = VerifyAndUpdateSimpleEntityCollection(parsedContent, entityName, 'Pattern.Any');
        if (rolesImport.length !== 0) {
            rolesImport.forEach(role => !entityRoles.includes(role) ? entityRoles.push(role) : undefined);
        }
    } catch (err) {
        throw (err);
    }

    let PAExists = parsedContent.LUISJsonStructure.patternAnyEntities.find(item => item.name == entityName);
    if (PAExists === undefined) {
        parsedContent.LUISJsonStructure.patternAnyEntities.push(new helperClass.patternAnyEntity(entityName, [], entityRoles));
    } else {
        entityRoles.forEach(item => {
            if (!PAExists.roles.includes) PAExists.roles.push(item);
        })
    }
}
/**
 * Helper function to remove duplicate pattern any definitions.
 * @param {Object} parsedContent Object containing current parsed content - LUIS, QnA, QnA alterations.
 * @param {String} pEntityName name of entity
 * @param {String} entityType type of entity
 * @param {String} entityLine current line being parsed
 */
const RemoveDuplicatePatternAnyEntity = function(parsedContent, pEntityName, entityType, entityLine) {
    // see if we already have this as Pattern.Any entity
    // see if we already have this in patternAny entity collection; if so, remove it but remember the roles (if any)
    let PAIdx = -1;
    let entityRoles = [];
    let PAEntityFound = parsedContent.LUISJsonStructure.patternAnyEntities.find(function(item, idx) {
        if(item.name === pEntityName) {
            PAIdx = idx;
            return true
        } else {
            return false;
        }
    });
    if (PAEntityFound !== undefined && PAIdx !== -1) {
        if (entityType.toLowerCase().trim().includes('phraselist')) {
            let errorMsg = `Phrase lists cannot be used as an entity in a pattern "${pEntityName}"`;
            let error = BuildDiagnostic({
                message: errorMsg,
                context: entityLine
            })
            throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
        } 
        entityRoles = (PAEntityFound.roles.length !== 0) ? PAEntityFound.roles : [];
        parsedContent.LUISJsonStructure.patternAnyEntities.splice(PAIdx, 1);
    }
    return entityRoles;
};

/**
 * 
 * @param {Object} parsedContent parsed content that includes LUIS, QnA, QnA alternations
 * @param {String} entityName entity name
 * @param {String} entityType entity type
 * @param {String []} entityRoles Array of roles
 * @param {String []} valuesList Array of individual lines to be processed and added to phrase list.
 */
const handlePhraseList = function(parsedContent, entityName, entityType, entityRoles, valuesList, currentLine) {
    if (entityRoles.length !== 0) {
        let errorMsg = `Phrase list entity ${entityName} has invalid role definition with roles = ${entityRoles.join(', ')}. Roles are not supported for Phrase Lists`;
        let error = BuildDiagnostic({
            message: errorMsg,
            context: currentLine
        })

        throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
    }
    // check if this phraselist entity is already labelled in an utterance and or added as a simple entity. if so, throw an error.
    try {
        let rolesImport = VerifyAndUpdateSimpleEntityCollection(parsedContent, entityName, 'Phrase List');
        if (rolesImport.length !== 0) {
            rolesImport.forEach(role => !entityRoles.includes(role) ? entityRoles.push(role) : undefined);
        }
    } catch (err) {
        throw (err);
    }
    // is this interchangeable? 
    let intc = false;
    let lEntityType = entityType ? entityType : entityName;
    if (lEntityType.toLowerCase().includes('interchangeable')) {
        intc = true;
        if (entityType === undefined) entityName = lEntityType.split(/\(.*\)/g)[0];
    } 
    // add this to phraseList if it doesnt exist
    let pLValues = [];
    for (const phraseListValues of valuesList) {
        phraseListValues.split(/[,;]/g).map(item => item.trim()).forEach(item => pLValues.push(item));
   }

    let pLEntityExists = parsedContent.LUISJsonStructure.model_features.find(item => item.name == entityName);
    if (pLEntityExists) {
        if (pLEntityExists.mode === intc) {
            // for each item in plValues, see if it already exists
            pLValues.forEach(function (plValueItem) {
                if (!pLEntityExists.words.includes(plValueItem)) pLEntityExists.words += (pLEntityExists.words !== '' ? ',' : '') + plValueItem;
            })
        } else {
            let errorMsg = `Phrase list: "${entityName}" has conflicting definitions. One marked interchangeable and another not interchangeable`;
            let error = BuildDiagnostic({
                message: errorMsg,
                context: entity.ParseTree.entityLine()
            })

            throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
        }
    } else {
        parsedContent.LUISJsonStructure.model_features.push(new helperClass.modelObj(entityName, intc, pLValues.join(','), true));
    }
}

/**
 * 
 * @param {Object} parsedContent parsed LUIS, QnA and QnA alternations
 * @param {String} entityName entity name
 * @param {String} entityType entity type
 * @param {String []} entityRoles list of entity roles
 * @param {String} locale current locale
 * @param {Boolean} log boolean to indicate if errors should be sent to stdout
 * @param {String} currentLine current line being parsed.
 */
const handlePrebuiltEntity = function(parsedContent, entityName, entityType, entityRoles, locale, log, currentLine) {
    locale = locale ? locale.toLowerCase() : 'en-us';
    // check if this pre-built entity is already labelled in an utterance and or added as a simple entity. if so, throw an error.
    try {
        let rolesImport = VerifyAndUpdateSimpleEntityCollection(parsedContent, entityType, entityName);
        if (rolesImport.length !== 0) {
            rolesImport.forEach(role => !entityRoles.includes(role) ? entityRoles.push(role) : undefined);
        }
    } catch (err) {
        throw (err);
    }
    // verify if the requested entityType is available in the requested locale
    if (!builtInTypes.consolidatedList.includes(entityType)) {
        let errorMsg = `Unknown PREBUILT entity '${entityType}'. Available pre-built types are ${builtInTypes.consolidatedList.join(',')}`;
        let error = BuildDiagnostic({
            message: errorMsg,
            context: currentLine
        })

        throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
    }
    let prebuiltCheck = builtInTypes.perLocaleAvailability[locale][entityType];
    if (prebuiltCheck === null) {
        if (log) {
            process.stdout.write(chalk.default.yellowBright('[WARN]: Requested PREBUILT entity "' + entityType + ' is not available for the requested locale: ' + locale + '\n'));
            process.stdout.write(chalk.default.yellowBright('  Skipping this prebuilt entity..\n'));
        } else {
            let errorMsg = `PREBUILT entity '${entityType}' is not available for the requested locale '${locale}'`;
            let error = BuildDiagnostic({
                message: errorMsg,
                context: currentLine
            })

            throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
        }
    } else if (prebuiltCheck && prebuiltCheck.includes('datetime')) {
        if (log) {
            process.stdout.write(chalk.default.yellowBright('[WARN]: PREBUILT entity "' + entityType + ' is not available for the requested locale: ' + locale + '\n'));
            process.stdout.write(chalk.default.yellowBright('  Switching to ' + builtInTypes.perLocaleAvailability[locale][entityType] + ' instead.\n'));
        }
        entityType = builtInTypes.perLocaleAvailability[locale][entityType];
        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.PREBUILT, entityType, entityRoles);
    } else {
        // add to prebuiltEntities if it does not exist there.
        addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.PREBUILT, entityType, entityRoles);
    }
};
/**
 * Helper function to handle composite entity definition.
 * @param {Object} parsedContent Object representing parsed content
 * @param {String} entityName entity name
 * @param {String} entityType entity type
 * @param {String []} entityRoles collection of roles
 * @param {String} currentLine current line being parsed 
 * @param {Boolean} inlineChildRequired boolean to indicate if children definition must be defined inline.
 */
const handleComposite = function(parsedContent, entityName, entityType, entityRoles, currentLine, inlineChildRequired) {
    // remove simple entity definitions for composites but carry forward roles.
    // Find this entity if it exists in the simple entity collection
    let simpleEntityExists = (parsedContent.LUISJsonStructure.entities || []).find(item => item.name == entityName);
    if (simpleEntityExists !== undefined) {
        // take and add any roles into the roles list
        (simpleEntityExists.roles || []).forEach(role => !entityRoles.includes(role) ? entityRoles.push(role) : undefined);
        // remove this simple entity definition
        for (var idx = 0; idx < parsedContent.LUISJsonStructure.entities.length; idx++) {
            if (parsedContent.LUISJsonStructure.entities[idx].name === simpleEntityExists.name) {
                parsedContent.LUISJsonStructure.entities.splice(idx, 1);
            }
        }
    }
    // handle composite entity definition
    // drop [] and trim
    let childDefinition = entityType.trim().replace('[', '').replace(']', '').trim();
    if (childDefinition.length === 0 && inlineChildRequired) {
        let errorMsg = `Composite entity: ${entityName} is missing child entity definitions. Child entities are denoted via [entity1, entity2] notation.`;
        let error = BuildDiagnostic({
            message: errorMsg,
            context: currentLine
        })

        throw (new exception(retCode.errorCode.INVALID_COMPOSITE_ENTITY, error.toString()));
    }
    // split the children based on ',' or ';' delimiter. Trim each child to remove white spaces.
    let compositeChildren = childDefinition !== "" ? childDefinition.split(new RegExp(/[,;]/g)).map(item => item.trim()) : [];
    // add this composite entity if it does not exist
    let compositeEntity = (parsedContent.LUISJsonStructure.composites || []).find(item => item.name == entityName);
    if (compositeEntity === undefined) {
        // add new composite entity
        parsedContent.LUISJsonStructure.composites.push(new helperClass.compositeEntity(entityName, compositeChildren, entityRoles));

        // remove composite that might have been tagged as a simple entity due to inline entity definition in an utterance
        parsedContent.LUISJsonStructure.entities = (parsedContent.LUISJsonStructure.entities || []).filter(entity => entity.name != entityName);
    } else {
        if (compositeEntity.children.length !== 0 && JSON.stringify(compositeChildren.sort()) !== JSON.stringify(compositeEntity.children.sort())) {
            let errorMsg = `Composite entity: ${entityName} has multiple definition with different children. \n 1. ${compositeChildren.join(', ')}\n 2. ${compositeEntity.children.join(', ')}`;
            let error = BuildDiagnostic({
                message: errorMsg,
                context: currentLine
            })

            throw (new exception(retCode.errorCode.INVALID_COMPOSITE_ENTITY, error.toString()));
        } else {
            // update roles
            // update children
            compositeChildren.forEach(item => compositeEntity.children.push(item));
            addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.COMPOSITES, compositeEntity.name, entityRoles);
        }
    }
};

/**
 * Helper function to handle list entity definition
 * @param {Object} parsedContent parsed LUIS, QnA and QnA alternations content
 * @param {String} entityName entity name
 * @param {String []} listLines lines to parse for the list entity
 * @param {String []} entityRoles collection of roles found
 * @param {String} currentLine current line being parsed.
 */
const handleClosedList = function (parsedContent, entityName, listLines, entityRoles, currentLine) {
    // check if this list entity is already labelled in an utterance and or added as a simple entity. if so, throw an error.
    try {
        let rolesImport = VerifyAndUpdateSimpleEntityCollection(parsedContent, entityName, 'List');
        rolesImport.forEach(role => {
            if (!entityRoles.includes(role)) {
                entityRoles.push(role)
            }
        });
    } catch (err) {
        throw (err);
    }
    // Find closed list by this name if it exists
    let closedListExists = parsedContent.LUISJsonStructure.closedLists.find(item => item.name == entityName);
    let addCL = false;
    if (closedListExists === undefined) {
        closedListExists = new helperClass.closedLists(entityName);
        addCL = true;
    }
    let addNV = false;    
    let nvExists;
    listLines.forEach(line => {
        if (line.toLowerCase().endsWith(':')) {
            // close if we are in the middle of a sublist.
            if (addNV) {
                closedListExists.subLists.push(nvExists);
                addNV = false;
                nvExists = undefined;
            }
            // find the matching sublist and if none exists, create one. 
            let normalizedValue = line.replace(/:$/g, '').trim();
            nvExists = closedListExists.subLists.find(item => item.canonicalForm == normalizedValue);
            if (nvExists === undefined) {
                nvExists = new helperClass.subList(normalizedValue);
                addNV = true;
            }
        } else {
            line.split(/[,;]/g).map(item => item.trim()).forEach(item => {
                if (!nvExists || !nvExists.list) {
                    let errorMsg = `Closed list ${entityName} has synonyms list "${line}" without a normalized value.`;
                    let error = BuildDiagnostic({
                        message: errorMsg,
                        context: currentLine
                    })

                    throw (new exception(retCode.errorCode.SYNONYMS_NOT_A_LIST, error.toString()));
                }
                if (!nvExists.list.includes(item)) nvExists.list.push(item);
            })
        }
    });

    if (addNV) {
        closedListExists.subLists.push(nvExists);
    }

    // merge roles
    entityRoles.forEach(item => {
        if(!closedListExists.roles.includes(item)) closedListExists.roles.push(item);
    });

    if (addCL) {
        parsedContent.LUISJsonStructure.closedLists.push(closedListExists);
    }
}
/**
 * Reference parser code to parse reference section.
 * @param {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {LUResouce} luResource resources extracted from lu file content
 * @param {boolean} log indicates if we need verbose logging.
 * @param {string} locale LUIS locale code
 * @throws {exception} Throws on errors. exception object includes errCode and text.
 */
const parseAndHandleEntity = function (parsedContent, luResource, log, locale) {
    // handle entity
    let entities = luResource.Entities;
    if (entities && entities.length > 0) {
        for (const entity of entities) {
            let entityName = entity.Name;
            let entityType = entity.Type;
            let parsedRoleAndType = helpers.getRolesAndType(entityType);
            let entityRoles = parsedRoleAndType.roles;
            entityType = parsedRoleAndType.entityType;
            let pEntityName = (entityName.toLowerCase() === 'prebuilt') ? entityType : entityName;
            
            // see if we already have this as Pattern.Any entity
            // see if we already have this in patternAny entity collection; if so, remove it but remember the roles (if any)
            let PAEntityRoles = RemoveDuplicatePatternAnyEntity(parsedContent, pEntityName, entityType, entity.ParseTree.entityLine());
            if (PAEntityRoles.length > 0) {
                PAEntityRoles.forEach(role => {
                    if (!entityRoles.includes(role)) entityRoles.push(role);
                })
            }

            // add this entity to appropriate place
            // is this a builtin type?
            if (builtInTypes.consolidatedList.includes(entityType)) {
                handlePrebuiltEntity(parsedContent, entityName, entityType, entityRoles, locale, log, entity.ParseTree.entityLine());
            } else if (entityType.toLowerCase() === 'simple') {
                // add this to entities if it doesnt exist
                addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.ENTITIES, entityName, entityRoles);
            } else if (entityType.endsWith('=')) {
                // is this qna maker alterations list? 
                if (entityType.includes(PARSERCONSTS.QNAALTERATIONS)) {
                    let alterationlist = [entity.Name];
                    if (entity.SynonymsOrPhraseList && entity.SynonymsOrPhraseList.length > 0) {
                        alterationlist = alterationlist.concat(entity.SynonymsOrPhraseList);
                        parsedContent.qnaAlterations.wordAlterations.push(new qnaAlterations.alterations(alterationlist));
                    } else {
                        let errorMsg = `QnA alteration section: "${alterationlist}" does not have list decoration. Prefix line with "-" or "+" or "*"`;
                        let error = BuildDiagnostic({
                            message: errorMsg,
                            context: entity.ParseTree.entityLine()
                        })

                        throw (new exception(retCode.errorCode.SYNONYMS_NOT_A_LIST, error.toString()));
                    }
                } else {
                    // treat this as a LUIS list entity type
                    let parsedEntityTypeAndRole = helpers.getRolesAndType(entityType);
                    entityType = parsedEntityTypeAndRole.entityType;
                    (parsedEntityTypeAndRole.roles || []).forEach(role => !entityRoles.includes(role) ? entityRoles.push(role) : undefined);

                    // check if this list entity is already labelled in an utterance and or added as a simple entity. if so, throw an error.
                    try {
                        let rolesImport = VerifyAndUpdateSimpleEntityCollection(parsedContent, entityName, 'List');
                        if (rolesImport.length !== 0) {
                            rolesImport.forEach(role => {
                                if (!entityRoles.includes(role)) {
                                    entityRoles.push(role)
                                }
                            })
                        }
                    } catch (err) {
                        throw (err);
                    }
                    // get normalized value
                    let normalizedValue = entityType.substring(0, entityType.length - 1).trim();
                    let synonymsList = entity.SynonymsOrPhraseList;
                    let closedListExists = helpers.filterMatch(parsedContent.LUISJsonStructure.closedLists, 'name', entityName);
                    if (closedListExists.length === 0) {
                        parsedContent.LUISJsonStructure.closedLists.push(new helperClass.closedLists(entityName, [new helperClass.subList(normalizedValue, synonymsList)], entityRoles));
                    } else {
                        // closed list with this name already exists
                        let subListExists = helpers.filterMatch(closedListExists[0].subLists, 'canonicalForm', normalizedValue);
                        if (subListExists.length === 0) {
                            closedListExists[0].subLists.push(new helperClass.subList(normalizedValue, synonymsList));
                        } else {
                            synonymsList.forEach(function (listItem) {
                                if (!subListExists[0].list.includes(listItem)) subListExists[0].list.push(listItem);
                            })
                        }
                        // see if the roles all exist and if not, add them
                        mergeRoles(closedListExists[0].roles, entityRoles);
                    }
                }
            } else if (entityType.toLowerCase().trim().indexOf('phraselist') === 0) {
                handlePhraseList(parsedContent, entityName, entityType, entityRoles, entity.SynonymsOrPhraseList, entity.ParseTree.entityLine());
            } else if (entityType.startsWith('[')) {
                handleComposite(parsedContent, entityName, entityType, entityRoles, entity.ParseTree.entityLine(), true);
            } else if (entityType.startsWith('/')) {
                if (entityType.endsWith('/')) {
                    handleRegExEntity(parsedContent, entityName, entityType, entityRoles, entity.ParseTree.entityLine());
                } else {
                    let errorMsg = `RegEx entity: ${regExEntity.name} is missing trailing '/'. Regex patterns need to be enclosed in forward slashes. e.g. /[0-9]/`;
                    let error = BuildDiagnostic({
                        message: errorMsg,
                        context: entity.ParseTree.entityLine()
                    })

                    throw (new exception(retCode.errorCode.INVALID_REGEX_ENTITY, error.toString()));
                }
            } else {
                // TODO: handle other entity types
            }
        }
    }
};
/**
 * 
 * @param {Object} parsedContent Object containing the parsed structure - LUIS, QnA, QnA alterations
 * @param {String} entityName name of entity
 * @param {String} entityType type of entity
 * @param {String []} entityRoles array of entity roles found
 * @param {String} entityLine current line being parsed/ handled.
 */
const handleRegExEntity = function(parsedContent, entityName, entityType, entityRoles, entityLine) {
    // check if this regex entity is already labelled in an utterance and or added as a simple entity. if so, throw an error.
    try {
        let rolesImport = VerifyAndUpdateSimpleEntityCollection(parsedContent, entityName, 'RegEx');
        if (rolesImport.length !== 0) {
            rolesImport.forEach(role => !entityRoles.includes(role) ? entityRoles.push(role) : undefined);
        }
    } catch (err) {
        throw (err);
    }
    let regex = '';
    // handle regex entity 
    if (entityType) {
        regex = entityType.slice(1, entityType.length - 1);
        if (regex === '') {
            let errorMsg = `RegEx entity: ${entityName} has empty regex pattern defined.`;
            let error = BuildDiagnostic({
                message: errorMsg,
                context: entityLine
            })

            throw (new exception(retCode.errorCode.INVALID_REGEX_ENTITY, error.toString()));
        }
    }
    
    // add this as a regex entity if it does not exist
    let regExEntity = (parsedContent.LUISJsonStructure.regex_entities || []).find(item => item.name == entityName);
    if (regExEntity === undefined) {
        parsedContent.LUISJsonStructure.regex_entities.push(new helperClass.regExEntity(entityName, regex, entityRoles))
    } else {
        // throw an error if the pattern is different for the same entity
        if (regExEntity.regexPattern !== '' && regex !== '' && regExEntity.regexPattern !== regex) {
            let errorMsg = `RegEx entity: ${regExEntity.name} has multiple regex patterns defined. \n 1. /${regex}/\n 2. /${regExEntity.regexPattern}/`;
            let error = BuildDiagnostic({
                message: errorMsg,
                context: entityLine
            })

            throw (new exception(retCode.errorCode.INVALID_REGEX_ENTITY, error.toString()));
        } else {
            // update roles
            addItemOrRoleIfNotPresent(parsedContent.LUISJsonStructure, LUISObjNameEnum.REGEX, regExEntity.name, entityRoles);
            // add regex pattern
            if (regExEntity.regexPattern === '') regExEntity.regexPattern = regex;
        }
    }
}

/**
 * Intent parser code to parse intent section.
 * @param {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {LUResouce} luResource resources extracted from lu file content
 * @throws {exception} Throws on errors. exception object includes errCode and text.
 */
const parseAndHandleQna = function (parsedContent, luResource) {
    // handle QNA
    let qnas = luResource.Qnas;
    if (qnas && qnas.length > 0) {
        for (const qna of qnas) {
            let questions = qna.Questions;
            let filterPairs = qna.FilterPairs;
            let metadata = [];
            if (filterPairs && filterPairs.length > 0) {
                filterPairs.forEach(pair => metadata.push(new qnaMetaDataObj(pair.key, pair.value)));
            }

            let answer = qna.Answer;
            parsedContent.qnaJsonStructure.qnaList.push(new qnaListObj(0, answer.trim(), 'custom editorial', questions, metadata));
        }
    }
}

/**
 * Intent parser code to parse intent section.
 * @param {parserObj} Object with that contains list of additional files to parse, parsed LUIS object and parsed QnA object
 * @param {LUResouce} luResource resources extracted from lu file content
 * @param {boolean} log indicates if we need verbose logging.
 * @throws {exception} Throws on errors. exception object includes errCode and text.
 */
const parseAndHandleModelInfo = function (parsedContent, luResource, log) {
    // handle model info
    let modelInfos = luResource.ModelInfos;
    if (modelInfos && modelInfos.length > 0) {
        for (const modelInfo of modelInfos) {
            let line = modelInfo.ModelInfo
            let kvPair = line.split(/@(app|kb|intent|entity).(.*)=/g).map(item => item.trim());
            if (kvPair.length === 4) {
                let hasError = false;
                kvPair.forEach(item => {
                    if (item.trim() === '') {
                        if (log) {
                            process.stdout.write(chalk.default.yellowBright('[WARN]: Invalid model info found. Skipping "' + line + '"\n'));
                        }

                        hasError = true;
                    }
                })

                if(hasError) {
                    continue;
                }

                if (kvPair[1].toLowerCase() === 'app') {
                    parsedContent.LUISJsonStructure[kvPair[2]] = kvPair[3];
                } else if (kvPair[1].toLowerCase() === 'kb') {
                    parsedContent.qnaJsonStructure[kvPair[2]] = kvPair[3];
                } else if (kvPair[1].toLowerCase() === 'intent') {
                    if (kvPair[2].toLowerCase() === 'inherits') {
                        let inheritsProperties = kvPair[3].split(/[:;]/g).map(item => item.trim());
                        if (inheritsProperties.length !== 6) {
                            process.stdout.write(chalk.default.yellowBright('[WARN]: Invalid intent inherits information found. Skipping "' + line + '"\n'));
                        } else {
                            // find the intent
                            let intent = parsedContent.LUISJsonStructure.intents.find(item => item.name == inheritsProperties[1]);
                            if (intent === undefined) {
                                let newIntent = {
                                    "name": inheritsProperties[1],
                                    "inherits": {}
                                };
                                newIntent['inherits'][inheritsProperties[2]] = inheritsProperties[3];
                                newIntent['inherits'][inheritsProperties[4]] = inheritsProperties[5];
                                parsedContent.LUISJsonStructure.intents.push(newIntent);
                            } else {
                                if (intent['inherits'] === undefined) intent['inherits'] = {};
                                intent['inherits'][inheritsProperties[2]] = inheritsProperties[3];
                                intent['inherits'][inheritsProperties[4]] = inheritsProperties[5];
                            }
                        }
                    } else {
                        if (log) {
                            process.stdout.write(chalk.default.yellowBright('[WARN]: Invalid intent inherits information found. Skipping "' + line + '"\n'));
                        }
                    }
                } else if (kvPair[1].toLowerCase() === 'entity') {
                    if (kvPair[2].toLowerCase() === 'inherits') {
                        let inheritsProperties = kvPair[3].split(/[:;]/g).map(item => item.trim());
                        if (inheritsProperties.length !== 6) {
                            process.stdout.write(chalk.default.yellowBright('[WARN]: Invalid entity inherits information found. Skipping "' + line + '"\n'));
                        } else {
                            // find the intent
                            let entity = parsedContent.LUISJsonStructure.entities.find(item => item.name == inheritsProperties[1]);
                            if (entity === undefined) {
                                let newEntity = {
                                    "name": inheritsProperties[1],
                                    "inherits": {}
                                };
                                newEntity['inherits'][inheritsProperties[2]] = inheritsProperties[3];
                                newEntity['inherits'][inheritsProperties[4]] = inheritsProperties[5];
                                parsedContent.LUISJsonStructure.entities.push(newEntity);
                            } else {
                                if (entity['inherits'] === undefined) entity['inherits'] = {};
                                entity['inherits'][inheritsProperties[2]] = inheritsProperties[3];
                                entity['inherits'][inheritsProperties[4]] = inheritsProperties[5];
                            }
                        }
                    } else {
                        if (log) {
                            process.stdout.write(chalk.default.yellowBright('[WARN]: Invalid entity inherits information found. Skipping "' + line + '"\n'));
                        }
                    }
                }
            } else {
                if (log) {
                    process.stdout.write(chalk.default.yellowBright('[WARN]: Invalid model info found. Skipping "' + line + '"\n'));
                }
            }
        }
    }
}


/**
 * Helper function to verify that the requested entity does not already exist
 * @param {parserObj} parsedContent parserObj containing current parsed content
 * @param {String} entityName 
 * @param {String} entityType 
 * @returns {String[]} Possible roles found to import into the explicitly defined entity type.
 * @throws {exception} Throws on errors. exception object includes errCode and text. 
 */
const VerifyAndUpdateSimpleEntityCollection = function (parsedContent, entityName, entityType) {
    let entityRoles = [];
    // Find this entity if it exists in the simple entity collection
    let simpleEntityExists = (parsedContent.LUISJsonStructure.entities || []).find(item => item.name == entityName);
    if (simpleEntityExists !== undefined) {
        // take and add any roles into the roles list
        (simpleEntityExists.roles || []).forEach(role => !entityRoles.includes(role) ? entityRoles.push(role) : undefined);
        // remove this simple entity definition
        // Fix for #1137.
        // Current behavior does not allow for simple and phrase list entities to have the same name. 
        if (entityType != 'Phrase List') {
            for (var idx = 0; idx < parsedContent.LUISJsonStructure.entities.length; idx++) {
                if (parsedContent.LUISJsonStructure.entities[idx].name === simpleEntityExists.name) {
                    parsedContent.LUISJsonStructure.entities.splice(idx, 1);
                }
            }
        }
    }
    // Find if this entity is referred in a labelled utterance
    let entityExistsInUtteranceLabel = (parsedContent.LUISJsonStructure.utterances || []).find(item => {
        let entityMatch = (item.entities || []).find(entity => entity.entity == entityName)
        if (entityMatch !== undefined) return true;
        return false;
    });

    if (entityExistsInUtteranceLabel !== undefined) {
        let entityMatch = entityExistsInUtteranceLabel.entities.filter(item => item.entity == entityName);
        entityMatch.forEach(entity => {
            if (entity.role !== undefined) {
                if (!entityRoles.includes(entity.role)) {
                    entityRoles.push(entity.role);
                }
            } else if (entityType !== 'Phrase List') {              // Fix for # 1151. Phrase lists can have same name as other entities.
                let errorMsg = `'${entityType}' entity: "${entityName}" is added as a labelled entity in utterance "${entityExistsInUtteranceLabel.text}". ${entityType} cannot be added with explicit labelled values in utterances.`
                let error = BuildDiagnostic({
                    message: errorMsg
                });

                throw (new exception(retCode.errorCode.INVALID_INPUT, error.toString()));
            }
        });
    }
    return entityRoles;
}

/**
 * Helper function to recursively pull entities from parsed utterance text
 * @param {parserEntity} list
 * @param {Object} retObj {entitiesFound, utteranceWithoutEntityLabel}
 * @param {number} parentIdx index where this list occurs in the parent
 * @returns {string[]} resolved values to add to the parent list
 * @throws {exception} Throws on errors. exception object includes errCode and text.  
 */
const flattenLists = function (list, retObj, parentIdx) {
    let retValue = []
    if (list.entity !== undefined) list.entity = list.entity.trim();
    if (list.role !== undefined) list.role = list.role.trim();
    if (list.startPos !== undefined) list.startPos = parentIdx;
    let offset = 0;
    list.value.forEach((item, idx) => {
        if (item instanceof helperClass.parserEntity) {
            let valuesToInsert = flattenLists(item, retObj, offset + parentIdx);
            if (valuesToInsert.length > 0) {
                retValue = retValue.concat(valuesToInsert);
                offset += valuesToInsert.length;
            }
        } else {
            retValue.push(item);
            if (item === ' ') {
                if (idx !== 0 && idx !== (list.value.length - 1)) {
                    offset++;
                }
            } else {
                offset++;
            }
        }
    });
    if (list.value.length === 0) {
        list.type = LUISObjNameEnum.PATTERNANYENTITY;
        if (list.role != '') {
            retValue = `{${list.entity}:${list.role}}`.split('');
        } else {
            retValue = `{${list.entity}}`.split('');
        }
    } else {
        list.type = LUISObjNameEnum.ENTITIES;
    }
    retValue = retValue.join('').trim();
    if (list.endPos !== undefined) list.endPos = parentIdx + retValue.length - 1;
    retObj.entitiesFound.push(new helperClass.parserEntity(undefined, list.startPos, list.entity, retValue, list.endPos, list.type, list.role));
    return retValue.split('');
};

/**
 * Helper function to add an item to collection if it does not exist
 * @param {object} collection contents of the current collection
 * @param {LUISObjNameEnum} type item type
 * @param {object} value value of the current item to examine and add
 * @returns {void} nothing
 */
const addItemIfNotPresent = function (collection, type, value) {
    let hasValue = false;
    for (let i in collection[type]) {
        if (collection[type][i].name === value) {
            hasValue = true;
            break;
        }
    }
    if (!hasValue) {
        let itemObj = {};
        itemObj.name = value;
        if (type == LUISObjNameEnum.PATTERNANYENTITY) {
            itemObj.explicitList = [];
        }
        if (type !== LUISObjNameEnum.INTENT) {
            itemObj.roles = [];
        }
        collection[type].push(itemObj);
    }
};

/**
 * Helper function to add an item to collection if it does not exist
 * @param {object} collection contents of the current collection
 * @param {LUISObjNameEnum} type item type
 * @param {object} value value of the current item to examine and add
 * @param {string []} roles possible roles to add to the item
 * @returns {void} nothing
 */
const addItemOrRoleIfNotPresent = function (collection, type, value, roles) {
    let existingItem = collection[type].filter(item => item.name == value);
    if (existingItem.length !== 0) {
        // see if the role exists and if so, merge
        mergeRoles(existingItem[0].roles, roles);
    } else {
        let itemObj = {};
        itemObj.name = value;
        if (type == LUISObjNameEnum.PATTERNANYENTITY) {
            itemObj.explicitList = [];
        }
        if (type !== LUISObjNameEnum.INTENT) {
            itemObj.roles = roles;
        }
        collection[type].push(itemObj);
    }
}

/**
 * Helper function merge roles
 * @param {string []} srcEntityRoles contents of the current collection
 * @param {string []} tgtEntityRoles target entity roles collection to merge
 * @returns {void} nothing
 */
const mergeRoles = function (srcEntityRoles, tgtEntityRoles) {
    const rolesMap = srcEntityRoles.reduce((map, role) => (map[role] = true, map), {});
    tgtEntityRoles.forEach(role => {
        if (!rolesMap[role]) {
            srcEntityRoles.push(role);
        }
    });
}

/**
 * Helper function that returns true if the item exists. Merges roles before returning 
 * @param {Object} collection contents of the current collection
 * @param {string} entityName name of entity to look for in the current collection
 * @param {string []} entityRoles target entity roles collection to merge
 * @returns {void} nothing
 */
const itemExists = function (collection, entityName, entityRoles) {
    let matchInClosedLists = helpers.filterMatch(collection, 'name', entityName);
    if (matchInClosedLists.length !== 0) {
        // merge roles if there are any roles in the pattern entity
        if (entityRoles.length !== 0) {
            mergeRoles(matchInClosedLists[0].roles, entityRoles);
        }
        return true;
    }
    return false;
}

module.exports = parseFileContentsModule;

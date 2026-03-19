import {
	ALL_MODELS,
	EXTRA_AI_MODELS,
	GENERAL_MODELS,
	MEETING_NOTES_MODELS,
	buildAllModels,
	type ModelCatalog,
	type ModelDefinition,
} from '../types';

let general: ModelDefinition[] = GENERAL_MODELS;
let extraAI: ModelDefinition[] = EXTRA_AI_MODELS;
let meetingNotes: ModelDefinition[] = MEETING_NOTES_MODELS;
let all: ModelDefinition[] = ALL_MODELS;

export function updateModels(catalog: ModelCatalog): void {
	general = catalog.general;
	extraAI = catalog.extraAI;
	meetingNotes = catalog.meetingNotes;
	all = buildAllModels(catalog);
}

export function getGeneralModels(): ModelDefinition[] {
	return general;
}

export function getExtraAIModels(): ModelDefinition[] {
	return extraAI;
}

export function getMeetingNotesModels(): ModelDefinition[] {
	return meetingNotes;
}

export function getAllModels(): ModelDefinition[] {
	return all;
}

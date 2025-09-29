import { ConversationalResponseType } from "../schemas";
import { createAssistantMessage, createUserMessage } from "../inferutils/common";
import { executeInference } from "../inferutils/infer";
import { getSystemPromptWithProjectContext } from "./common";
import { WebSocketMessageResponses } from "../constants";
import { WebSocketMessageData } from "../../api/websocketTypes";
import { AgentOperation, OperationOptions } from "../operations/common";
import { ConversationMessage } from "../inferutils/common";
import { StructuredLogger } from "../../logger";
import { IdGenerator } from "../utils/idGenerator";
// 🔧 corrigido caminho do shared/types/errors
import { RateLimitExceededError, SecurityError } from "../../../shared/types/errors";
import { toolWebSearchDefinition } from "../tools/toolkit/web-search";
import { toolWeatherDefinition } from "../tools/toolkit/weather";
import { ToolDefinition } from "../tools/types";

// Constants
const CHUNK_SIZE = 64;

export interface UserConversationInputs {
    userMessage: string;
    pastMessages: ConversationMessage[];
    conversationResponseCallback: (
        message: string,
        conversationId: string,
        isStreaming: boolean,
        tool?: { name: string; status: 'start' | 'success' | 'error'; args?: Record<string, unknown> }
    ) => void;
}

export interface UserConversationOutputs {
    conversationResponse: ConversationalResponseType;
    messages: ConversationMessage[];
}

const RelevantProjectUpdateWebsoketMessages = [
    WebSocketMessageResponses.PHASE_IMPLEMENTING,
    WebSocketMessageResponses.PHASE_IMPLEMENTED,
    WebSocketMessageResponses.CODE_REVIEW,
    WebSocketMessageResponses.FILE_REGENERATING,
    WebSocketMessageResponses.FILE_REGENERATED,
    WebSocketMessageResponses.DEPLOYMENT_COMPLETED,
    WebSocketMessageResponses.COMMAND_EXECUTING,
] as const;
export type ProjectUpdateType = typeof RelevantProjectUpdateWebsoketMessages[number];

const SYSTEM_PROMPT = `You are Orange, an AI assistant for Cloudflare's AI powered vibe coding development platform, helping users build and modify their applications. You have a conversational interface and can help users with their projects.

## YOUR CAPABILITIES:
- You can answer questions about the project and its current state
- You can search the web for information when needed
- Most importantly, you can modify the application when users request changes or ask for new features or points of issues/bugs
- You can execute other tools provided to you to help users with their projects

## HOW TO INTERACT:
[... resto do prompt mantido ...]`;

const FALLBACK_USER_RESPONSE = "I understand you'd like to make some changes to your project. Let me make sure this is incorporated in the next phase of development.";

interface EditAppArgs {
    modificationRequest: string;
}

interface EditAppResult {}

export function buildEditAppTool(stateMutator: (modificationRequest: string) => void): ToolDefinition<EditAppArgs, EditAppResult> {
    return {
        type: 'function' as const,
        function: {
            name: 'queue_request',
            description: 'Queue up modification requests or changes, to be implemented in the next development phase',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    modificationRequest: {
                        type: 'string',
                        minLength: 8,
                        description: 'The changes needed to be made to the app. Please don\'t supply any code level or implementation details. Provide detailed requirements and description of the changes you want to make.'
                    }
                },
                required: ['modificationRequest']
            }
        },
        implementation: async (args: EditAppArgs) => {
            console.log("Queueing app edit request", args);
            stateMutator(args.modificationRequest);
            return {content: "Modification request queued successfully, will be implemented in the next phase of development."};
        }
    };
}

export class UserConversationProcessor extends AgentOperation<UserConversationInputs, UserConversationOutputs> {
    async execute(inputs: UserConversationInputs, options: OperationOptions): Promise<UserConversationOutputs> {
        const { env, logger, context } = options;
        const { userMessage, pastMessages } = inputs;
        logger.info("Processing user message", { 
            messageLength: inputs.userMessage.length,
        });

        try {
            const systemPrompts = getSystemPromptWithProjectContext(SYSTEM_PROMPT, context, false);
            const messages = [...pastMessages, {...createUserMessage(userMessage), conversationId: IdGenerator.generateConversationId()}];

            let extractedUserResponse =

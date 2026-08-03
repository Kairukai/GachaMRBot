import type {
  ChatInputCommandInteraction,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandBuilder,
} from "discord.js";
import * as roll from "./roll.js";
import * as collection from "./collection.js";
import * as rates from "./rates.js";

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
}

export const commands = new Map<string, Command>(
  ([roll, collection, rates] as unknown as Command[]).map((c) => [c.data.name, c]),
);

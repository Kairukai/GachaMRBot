import type {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandBuilder,
} from "discord.js";
import * as roll from "./roll.js";
import * as collection from "./collection.js";
import * as rates from "./rates.js";
import * as help from "./help.js";
import * as trade from "./trade.js";

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  /** Optional — only commands with autocompleting options define this. */
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<unknown>;
}

export const commands = new Map<string, Command>(
  ([roll, collection, rates, help, trade] as unknown as Command[]).map((c) => [
    c.data.name,
    c,
  ]),
);

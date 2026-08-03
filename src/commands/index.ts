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
import * as sell from "./sell.js";
import * as sellall from "./sellall.js";
import * as flexers from "./flexers.js";
import * as roll5 from "./roll5.js";
import * as cdcheck from "./cdcheck.js";
import * as showcase from "./showcase.js";

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  /** Optional — only commands with autocompleting options define this. */
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<unknown>;
}

export const commands = new Map<string, Command>(
  (
    [
      roll,
      roll5,
      collection,
      rates,
      cdcheck,
      showcase,
      help,
      trade,
      sell,
      sellall,
      flexers,
    ] as unknown as Command[]
  ).map((c) => [c.data.name, c]),
);

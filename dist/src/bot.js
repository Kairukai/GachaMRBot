import "dotenv/config";
import { Client, GatewayIntentBits, Events, MessageFlags, Options } from "discord.js";
import { commands } from "./commands/index.js";
import { handleClaim, CLAIM_PREFIX } from "./lib/claim.js";
import { handleTradeButton, TRADE_PREFIX } from "./lib/trade.js";
import { handleSellButton, SELL_PREFIX } from "./lib/sell.js";
import { handleGiveButton, GIVE_PREFIX } from "./lib/give.js";
import { handleBuyButton, BUY_PREFIX } from "./lib/shop.js";
import { handleRankUpButton, RANKUP_PREFIX } from "./lib/rankup.js";
import { handleChallengeButton, CHALLENGE_PREFIX } from "./lib/wager.js";
import { startHealthServer } from "./lib/health.js";
import { loadRankBadges } from "./lib/badges.js";
const token = process.env.DISCORD_TOKEN;
if (!token) {
    const envFile = process.env.DOTENV_CONFIG_PATH ?? ".env";
    throw new Error(`DISCORD_TOKEN is not set in ${envFile}. ` +
        (envFile === ".env.dev"
            ? "Copy .env.dev.example to .env.dev and fill in your DEV bot's token."
            : "Copy .env.example to .env and fill it in."));
}
// Guilds is all we need: everything runs through slash commands and buttons,
// so no Message Content intent and no privileged-intent review.
//
// Caches are trimmed to what the bot actually reads. It never inspects
// messages, members, presences, reactions or threads — interactions carry the
// user and guild on the payload — so caching them is pure memory cost. This
// matters on small free hosts with ~128 MB budgets.
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        PresenceManager: 0,
        GuildMemberManager: 0,
        ReactionManager: 0,
        ReactionUserManager: 0,
        ThreadManager: 0,
        ThreadMemberManager: 0,
        GuildStickerManager: 0,
        GuildScheduledEventManager: 0,
        AutoModerationRuleManager: 0,
    }),
});
client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag} (${c.guilds.cache.size} guilds)`);
    // Application emojis can only be fetched once the client is ready.
    await loadRankBadges(c);
});
// No-op unless PORT is set (Render and similar). Reports 503 until the gateway
// is up, so a platform health check can't call a half-started bot healthy.
startHealthServer(() => client.isReady());
client.on(Events.InteractionCreate, async (interaction) => {
    // Claim buttons are handled here, not by a per-message collector, so they
    // keep working across restarts and shards. Other custom ids (pagination)
    // fall through to their own collectors.
    if (interaction.isButton()) {
        const id = interaction.customId;
        const handler = id.startsWith(CLAIM_PREFIX)
            ? handleClaim
            : id.startsWith(TRADE_PREFIX)
                ? handleTradeButton
                : id.startsWith(SELL_PREFIX)
                    ? handleSellButton
                    : id.startsWith(GIVE_PREFIX)
                        ? handleGiveButton
                        : id.startsWith(BUY_PREFIX)
                            ? handleBuyButton
                            : id.startsWith(RANKUP_PREFIX)
                                ? handleRankUpButton
                                : id.startsWith(CHALLENGE_PREFIX)
                                    ? handleChallengeButton
                                    : null;
        if (!handler)
            return;
        try {
            await handler(interaction);
        }
        catch (err) {
            console.error("button failed:", err);
            await interaction
                .reply({ content: "Couldn't process that.", flags: MessageFlags.Ephemeral })
                .catch(() => { });
        }
        return;
    }
    if (interaction.isAutocomplete()) {
        const command = commands.get(interaction.commandName);
        try {
            await command?.autocomplete?.(interaction);
        }
        catch (err) {
            console.error(`autocomplete for /${interaction.commandName} failed:`, err);
            await interaction.respond([]).catch(() => { });
        }
        return;
    }
    if (!interaction.isChatInputCommand())
        return;
    const command = commands.get(interaction.commandName);
    if (!command)
        return;
    try {
        await command.execute(interaction);
    }
    catch (err) {
        console.error(`/${interaction.commandName} failed:`, err);
        const body = {
            content: "Something broke running that command.",
            flags: MessageFlags.Ephemeral,
        };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(body).catch(() => { });
        }
        else {
            await interaction.reply(body).catch(() => { });
        }
    }
});
client.login(token);
//# sourceMappingURL=bot.js.map
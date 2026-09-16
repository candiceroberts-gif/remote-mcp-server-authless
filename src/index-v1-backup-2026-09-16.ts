import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import type { Props } from "./utils";

const ALLOWED_GITHUB_USERS = new Set(["candiceroberts-gif"]);
const LEAD_AR_URL =
	"https://lead-ar-connector.candiceroberts.workers.dev";

export class MyMCP extends McpAgent<
	Env,
	Record<string, never>,
	Props
> {
	server = new McpServer({
		name: "Lead AR Schedule Intelligence",
		version: "1.0.0",
	});

	private async callLeadAR(
		route: string,
		options: { date?: string; days_stale?: number } = {},
	) {
		if (!this.props || !ALLOWED_GITHUB_USERS.has(this.props.login)) {
			throw new Error("This GitHub account is not authorized.");
		}

		const url = new URL(LEAD_AR_URL);
		url.searchParams.set("route", route);

		if (options.date) {
			url.searchParams.set("date", options.date);
		}

		if (options.days_stale !== undefined) {
			url.searchParams.set(
				"days_stale",
				String(options.days_stale),
			);
		}

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${this.env.CONNECTOR_SECRET}`,
				Accept: "application/json",
			},
		});

		const text = await response.text();

		if (!response.ok) {
			throw new Error(
				`Lead AR returned ${response.status}: ${text}`,
			);
		}

		return {
			content: [{ type: "text" as const, text }],
		};
	}

	async init() {
		this.server.registerTool(
			"get_schedule_scrub",
			{
				description:
					"Get Lead AR schedule-scrubbing findings for a date. Use with an uploaded Aesthetic Record schedule.",
				inputSchema: {
					date: z
						.string()
						.describe("Date in YYYY-MM-DD format"),
				},
			},
			async ({ date }) =>
				this.callLeadAR("schedule-scrub-v2", { date }),
		);

		this.server.registerTool(
			"get_daily_schedule",
			{
				description:
					"Get the Lead AR daily schedule for comparison with Aesthetic Record.",
				inputSchema: {
					date: z
						.string()
						.describe("Date in YYYY-MM-DD format"),
				},
			},
			async ({ date }) =>
				this.callLeadAR("daily-schedule", { date }),
		);

		this.server.registerTool(
			"get_unconfirmed_appointments",
			{
				description:
					"Get the Unconfirmed Appointments warning layer. Do not treat this calendar as normal Patient Flow.",
				inputSchema: {
					date: z
						.string()
						.describe("Date in YYYY-MM-DD format"),
				},
			},
			async ({ date }) =>
				this.callLeadAR("unconfirmed-appointments", {
					date,
				}),
		);

		this.server.registerTool(
			"get_daily_lead_command_center",
			{
				description:
					"Get the daily Lead AR command-center report with priorities and follow-up issues.",
				inputSchema: {
					date: z
						.string()
						.describe("Date in YYYY-MM-DD format"),
					days_stale: z
						.number()
						.int()
						.min(1)
						.default(7),
				},
			},
			async ({ date, days_stale }) =>
				this.callLeadAR(
					"daily-lead-command-center",
					{ date, days_stale },
				),
		);

		this.server.registerTool(
			"get_pipeline_health",
			{
				description:
					"Review Lead AR pipeline health. Unassigned ownership is only a low-priority note unless the stage requires an owner.",
				inputSchema: {
					days_stale: z
						.number()
						.int()
						.min(1)
						.default(7),
				},
			},
			async ({ days_stale }) =>
				this.callLeadAR("pipeline-health-v2", {
					days_stale,
				}),
		);
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});

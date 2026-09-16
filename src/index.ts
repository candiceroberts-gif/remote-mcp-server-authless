import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import type { Props } from "./utils";

const ALLOWED_GITHUB_USERS = new Set(["candiceroberts-gif"]);
const LEAD_AR_URL = "https://lead-ar-connector.candiceroberts.workers.dev";

type LeadOptions = {
  date?: string;
  days_stale?: number;
  start_date?: string;
  end_date?: string;
  calendar_id?: string;
  appointment_status?: string;
  contact_id?: string;
  event_id?: string;
  rebooking_window_days?: number;
  include_history?: boolean;
};

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Lead AR Schedule Intelligence v3",
    version: "3.0.0",
  });

  private async callLeadAR(route: string, options: LeadOptions = {}) {
    if (!this.props || !ALLOWED_GITHUB_USERS.has(this.props.login)) {
      throw new Error("This GitHub account is not authorized.");
    }

    const url = new URL(LEAD_AR_URL);
    url.searchParams.set("route", route);

    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.env.CONNECTOR_SECRET}`,
        Accept: "application/json",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Lead AR returned ${response.status}: ${text}`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  }

  async init() {
    const date = z.string().describe("Date in YYYY-MM-DD format");
    const startDate = z
      .string()
      .describe("First date in YYYY-MM-DD format");
    const endDate = z
      .string()
      .describe("Last date in YYYY-MM-DD format, inclusive");
    const calendarId = z
      .string()
      .optional()
      .describe("Optional Lead AR calendar ID");

    this.server.registerTool(
      "get_schedule_scrub",
      {
        description:
          "Get Lead AR schedule-scrubbing findings for a date. Blocks remain available for schedule protection but are not treated as patient appointments.",
        inputSchema: {
          date,
        },
      },
      async ({ date }) =>
        this.callLeadAR("schedule-scrub-v2", {
          date,
        }),
    );

    this.server.registerTool(
      "get_daily_schedule",
      {
        description:
          "Get the Lead AR daily schedule with patient-vs-block classification and the separate unconfirmed warning layer.",
        inputSchema: {
          date,
        },
      },
      async ({ date }) =>
        this.callLeadAR("daily-schedule", {
          date,
        }),
    );

    this.server.registerTool(
      "get_unconfirmed_appointments",
      {
        description:
          "Get the Unconfirmed Appointments warning layer. Do not treat this calendar as normal Patient Flow.",
        inputSchema: {
          date,
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
          date,
          days_stale: z.number().int().min(1).default(7),
        },
      },
      async ({ date, days_stale }) =>
        this.callLeadAR("daily-lead-command-center", {
          date,
          days_stale,
        }),
    );

    this.server.registerTool(
      "get_pipeline_health",
      {
        description:
          "Review all paginated Lead AR opportunities for pipeline health. Unassigned ownership is not automatically a problem.",
        inputSchema: {
          days_stale: z.number().int().min(1).default(7),
        },
      },
      async ({ days_stale }) =>
        this.callLeadAR("pipeline-health-v2", {
          days_stale,
        }),
    );

    this.server.registerTool(
      "get_schedule_range",
      {
        description:
          "Get provider events and the separate Unconfirmed warning layer for an inclusive date range up to 93 days. Returns patient appointments and blocks separately while preserving all provider events.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
          calendar_id: calendarId,
          appointment_status: z.string().optional(),
        },
      },
      async (args) =>
        this.callLeadAR("schedule-range", args),
    );

    this.server.registerTool(
      "get_contact_upcoming_appointments",
      {
        description:
          "Get upcoming Lead AR appointments for one contact so multiple future appointments can be reconciled correctly.",
        inputSchema: {
          contact_id: z.string(),
          start_date: startDate,
          end_date: endDate,
        },
      },
      async (args) =>
        this.callLeadAR("contact-upcoming-appointments", args),
    );

    this.server.registerTool(
      "get_upcoming_confirmed_appointments",
      {
        description:
          "Get patient appointments marked confirmed across a date range for future-confirmation auditing.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
        },
      },
      async (args) =>
        this.callLeadAR("upcoming-confirmed-appointments", args),
    );

    this.server.registerTool(
      "get_upcoming_cancelled_appointments",
      {
        description:
          "Get retained patient appointments marked cancelled across a date range for Aesthetic Record reconciliation.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
        },
      },
      async (args) =>
        this.callLeadAR("upcoming-cancelled-appointments", args),
    );

    this.server.registerTool(
      "get_contact_conversation",
      {
        description:
          "Get fully paginated conversation activity for one contact, classified as automated texts, manual texts, inbound replies, calls, with delivery/call status.",
        inputSchema: {
          contact_id: z.string(),
          start_date: startDate,
          end_date: endDate,
        },
      },
      async (args) =>
        this.callLeadAR("contact-conversation", args),
    );

    this.server.registerTool(
      "get_appointment_confirmation_history",
      {
        description:
          "Reconstruct the five expected confirmation texts, Day-8 call attempt, patient replies, delivery status and appointment-match confidence.",
        inputSchema: {
          event_id: z.string(),
          contact_id: z.string().optional(),
        },
      },
      async (args) =>
        this.callLeadAR("appointment-confirmation-history", args),
    );

    this.server.registerTool(
      "get_contact_pipeline",
      {
        description:
          "Get all paginated patient-specific Lead AR opportunities, pipelines, stages, statuses, sources and timestamps.",
        inputSchema: {
          contact_id: z.string(),
        },
      },
      async (args) =>
        this.callLeadAR("contact-pipeline", args),
    );

    this.server.registerTool(
      "get_schedule_summary",
      {
        description:
          "Get CEO-ready schedule counts and booked hours using patient appointments only. Blocks are reported separately and excluded from appointment metrics.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
          calendar_id: calendarId,
        },
      },
      async (args) =>
        this.callLeadAR("schedule-summary", args),
    );

    this.server.registerTool(
      "get_confirmation_dashboard",
      {
        description:
          "Get confirmed/unconfirmed totals and warning risks using patient appointments only. Blocks are excluded from confirmation denominators.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
          calendar_id: calendarId,
        },
      },
      async (args) =>
        this.callLeadAR("confirmation-dashboard", args),
    );

    this.server.registerTool(
      "get_cancellation_rebooking_report",
      {
        description:
          "Compare retained live cancelled appointments with later appointments. For deleted-history completeness use the historical archive report.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
          rebooking_window_days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .default(90),
        },
      },
      async (args) =>
        this.callLeadAR("cancellation-rebooking-report", args),
    );

    this.server.registerTool(
      "get_archive_health",
      {
        description:
          "Read the Cloudflare D1 appointment archive health, coverage dates, record counts and captured change types. Read-only.",
        inputSchema: {},
      },
      async () =>
        this.callLeadAR("archive-health"),
    );

    this.server.registerTool(
      "get_historical_appointments",
      {
        description:
          "Read archived appointment metadata for a date range, including deleted records and optional event history. Operational metadata only; no clinical notes or full message bodies.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
          contact_id: z.string().optional(),
          event_id: z.string().optional(),
          include_history: z.boolean().default(false),
        },
      },
      async (args) =>
        this.callLeadAR("historical-appointments", args),
    );

    this.server.registerTool(
      "get_historical_cancellation_rebooking_report",
      {
        description:
          "Use the D1 archive to analyze cancellations/deletions and later rebooking from archive activation forward.",
        inputSchema: {
          start_date: startDate,
          end_date: endDate,
          rebooking_window_days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .default(90),
        },
      },
      async (args) =>
        this.callLeadAR(
          "historical-cancellation-rebooking-report",
          args,
        ),
    );

    // TEMPORARY DIAGNOSTIC TOOL
    // Manually triggers the exact archive snapshot function in lead-ar-connector.
    // It remains read-only to Lead AR and only writes operational metadata
    // to the Cloudflare D1 archive.
    this.server.registerTool(
      "run_archive_sync_now",
      {
        description:
          "Diagnostic only: manually trigger the Lead AR archive snapshot sync and return the resulting archive health. Read-only to Lead AR; writes only to the D1 appointment archive.",
        inputSchema: {},
      },
      async () =>
        this.callLeadAR("archive-sync-now"),
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

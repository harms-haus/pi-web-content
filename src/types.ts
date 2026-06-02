/** Structured details returned by fetch_content tool */
export interface FetchContentDetails {
  url?: string;
  title?: string;
  summarized?: boolean;
  summarizePrompt?: string;
  contentLength?: number;
  truncated?: boolean;
  fullOutputPath?: string;
  status?: string;
  /** Whether this was a web fetch or git repo clone */
  type: "web" | "repo";
  /** Repo owner (only for type=repo) */
  owner?: string;
  /** Repo name (only for type=repo) */
  repo?: string;
  /** Local path to cloned repo (only for type=repo) */
  targetPath?: string;
  /** Git branch that was cloned (only for type=repo) */
  branch?: string;
}

/** Streaming update payload for summarization progress. */
export type SummarizeUpdate = {
  content: Array<{ type: string; text: string }>;
  details: { status: string };
};

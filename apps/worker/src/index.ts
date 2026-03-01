export {
  DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
  DEFAULT_ALLOWED_POST_CATEGORIES,
  DEFAULT_BLOCKED_POST_RULE_IDS,
  loadConfig,
  resolveGitHubFetchOptions,
  type WorkerConfig,
  type WorkerGitHubFetchOptions,
} from "./config";

export {
  MERGEWISE_META_REGEX,
  buildStructuredFindingComment,
  wrapCodeIdentifiers,
  isCamelCaseOrPascalCase,
  buildSuggestedRewriteSection,
  buildAdditionalLocationsSection,
  canRenderGitHubSuggestedChange,
  createCodeFence,
  getLongestBacktickRun,
  buildDebugMetadataSection,
} from "./comment-formatter";

export {
  buildAnalysisContext,
  mapGitHubPullRequestFilesToDiffs,
  parsePatchToDiffHunks,
} from "./diff-parser";

export { loadGitHubAppCredentials } from "./github-auth";

export {
  type AnalyzePullRequestJobSummary,
  type WorkerCheckOutput,
  buildIdempotencyKey,
  resolveJobTraceId,
  parseRepositoryFullName,
  buildJobSummary,
  buildSkippedJobSummary,
  selectRulesForExecution,
  applyFindingGates,
  compareFindingsForGating,
} from "./job-utils";

export {
  type WorkerFindingDeliveryOptions,
  type WorkerReviewerSummaryOptions,
  type PreparedFindingComment,
  type PreparedFindingDelivery,
  buildFindingDedupeKey,
  prepareFindingDelivery,
  buildWorkerCheckOutput,
  isTestFilePath,
  buildReviewerSummaryMarkdown,
  formatEvidenceLinksForRule,
  formatEvidenceLocationLink,
} from "./delivery";

export {
  type ExistingCommentState,
  type PostedCommentRequestOptions,
  type PostedFindingCommentSuccess,
  type PostedFindingCommentFailure,
  type PostedFindingCommentSkipped,
  type PostPreparedFindingCommentsResult,
  type CommentFeedbackRecord,
  type CommentFeedbackSummary,
  postPreparedFindingComments,
  resolveOutdatedComments,
  loadExistingDedupeKeys,
  extractDedupeKeyFromCommentBody,
  collectCommentFeedback,
  logFeedbackSummary,
  extractMergewiseMeta,
  sumReactions,
} from "./pr-comments";

export {
  type PrSummaryInput,
  PR_SUMMARY_COMMENT_MARKER,
  CATEGORY_EMOJI,
  CATEGORY_SEVERITY_ORDER,
  buildPrSummaryComment,
  upsertPrSummaryComment,
  escapeTableCell,
  type FindingGroup,
  buildBlobUrl,
  buildLocationLink,
  INLINE_LOCATION_THRESHOLD,
  groupFindings,
  buildCollapsibleDetail,
} from "./pr-summary";

export {
  runPollCycleWithInFlightGuard,
  createPollingLoopController,
  createProcessedKeyState,
  trackProcessedKey,
  type ProcessedKeyState,
  type PollCycleState,
  type WorkerPollingTimerHandle,
  type PollingLoopDependencies,
  type PollingLoopController,
} from "./polling";

export {
  type PullRequestFileRetryDependencies,
  type GitHubAnalysisContextResult,
  type BuildAnalysisContextDependencies,
  fetchPullRequestFilesWithRetry,
  buildAnalysisContextFromGitHub,
  defaultSleep,
  isRetryablePullRequestFileFetchError,
} from "./github-fetch";

export {
  type WorkerProcessingDependencies,
  processAnalyzePullRequestJob,
} from "./process-job";

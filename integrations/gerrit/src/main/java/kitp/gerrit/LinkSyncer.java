package kitp.gerrit;

import com.google.common.flogger.FluentLogger;
import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.api.GerritApi;
import com.google.gerrit.extensions.client.ListChangesOption;
import com.google.gerrit.extensions.common.ChangeInfo;
import com.google.gerrit.extensions.common.RevisionInfo;
import com.google.gerrit.extensions.events.LifecycleListener;
import com.google.gerrit.extensions.registration.DynamicItem;
import com.google.gerrit.extensions.restapi.ResourceNotFoundException;
import com.google.gerrit.server.config.UrlFormatter;
import com.google.gerrit.server.git.WorkQueue;
import com.google.gerrit.server.util.ManualRequestContext;
import com.google.gerrit.server.util.OneOffRequestContext;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import java.util.EnumSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Pushes a change's link to kitp, off the request thread.
 *
 * <p>An event only NAMES the change; the worker re-reads its current state
 * (commit message, status, votes) and sends the whole link. That makes each
 * sync self-contained: events for one change that arrive together (a submit
 * fires comment-added + change-merged) coalesce into one request, a lost or
 * duplicated event is harmless, and kitp's (task, url) idempotency turns a
 * repeat into a no-op.
 */
@Singleton
class LinkSyncer implements LifecycleListener {
  private static final FluentLogger log = FluentLogger.forEnclosingClass();

  /** Wait this long after an event so a burst for one change coalesces. */
  private static final long COALESCE_MS = 1500;
  /** Backoff before retry n (1-based), capped at the last entry. */
  private static final long[] BACKOFF_SECONDS = {10, 60, 300};

  private final KitpConfig cfg;
  private final KitpClient client;
  private final GerritApi gApi;
  private final OneOffRequestContext requestContext;
  private final DynamicItem<UrlFormatter> urlFormatter;
  private final WorkQueue workQueue;
  /** Changes with a sync already scheduled (coalescing). */
  private final Set<String> pending = ConcurrentHashMap.newKeySet();
  private volatile ScheduledExecutorService executor;

  @Inject
  LinkSyncer(
      KitpConfig cfg,
      KitpClient client,
      GerritApi gApi,
      OneOffRequestContext requestContext,
      DynamicItem<UrlFormatter> urlFormatter,
      WorkQueue workQueue) {
    this.cfg = cfg;
    this.client = client;
    this.gApi = gApi;
    this.requestContext = requestContext;
    this.urlFormatter = urlFormatter;
    this.workQueue = workQueue;
  }

  @Override
  public void start() {
    executor = workQueue.createQueue(1, "kitp-links");
  }

  @Override
  public void stop() {
    ScheduledExecutorService ex = executor;
    if (ex != null) {
      ex.shutdown();
    }
  }

  /** Schedule a sync of one change; a sync already pending absorbs it. */
  void schedule(String project, int number) {
    ScheduledExecutorService ex = executor;
    if (ex == null || !cfg.isConfigured()) {
      return;
    }
    String key = project + "~" + number;
    if (pending.add(key)) {
      ex.schedule(() -> run(key, project, number, 0), COALESCE_MS, TimeUnit.MILLISECONDS);
    }
  }

  private void run(String key, String project, int number, int attempt) {
    pending.remove(key);
    try {
      sync(project, number);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    } catch (Exception e) {
      boolean retryable = !(e instanceof KitpClient.HookException he) || he.retryable;
      if (retryable && attempt < cfg.retries && executor != null) {
        long delay = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
        log.atWarning().withCause(e).log(
            "kitp: linking change %s failed; retry %d/%d in %ds", key, attempt + 1, cfg.retries, delay);
        executor.schedule(() -> run(key, project, number, attempt + 1), delay, TimeUnit.SECONDS);
      } else {
        log.atSevere().withCause(e).log("kitp: linking change %s failed; giving up", key);
      }
    }
  }

  private void sync(String project, int number) throws Exception {
    Project.NameKey projectKey = Project.nameKey(project);
    if (!cfg.enabledFor(projectKey)) {
      return;
    }
    ChangeInfo change;
    try (ManualRequestContext ctx = requestContext.open()) {
      change =
          gApi.changes()
              .id(project, number)
              .get(
                  EnumSet.of(
                      ListChangesOption.CURRENT_REVISION,
                      ListChangesOption.CURRENT_COMMIT,
                      ListChangesOption.DETAILED_LABELS,
                      ListChangesOption.SKIP_DIFFSTAT));
    } catch (ResourceNotFoundException e) {
      return; // deleted since the event fired
    }
    if (Boolean.TRUE.equals(change.isPrivate) && !cfg.includePrivate) {
      return;
    }
    List<String> tasks = TaskRefs.parse(cfg.taskPatterns, commitMessage(change));
    if (tasks.isEmpty()) {
      return;
    }
    Optional<String> url =
        urlFormatter.get().getChangeViewUrl(projectKey, Change.id(change._number));
    if (url.isEmpty()) {
      log.atWarning().log(
          "kitp: change %s~%d mentions tasks but gerrit.canonicalWebUrl is unset, so it has no URL to link",
          project, number);
      return;
    }
    String state = LinkState.of(change, cfg.reviewLabel);
    LinkRequest req = new LinkRequest(tasks, url.get(), change.subject, cfg.kind, state);
    LinkRequest.Response resp = client.post(req);
    for (LinkRequest.Result r : resp.results) {
      if (r.ok) {
        if (r.changed) {
          log.atFine().log(
              "kitp: task %s %s %s (%s)", r.taskId, r.created ? "linked" : "updated", url.get(), state);
        }
      } else {
        // A typo'd task number, or a task the plugin's account can't edit:
        // permanent for this change, so log rather than retry.
        log.atWarning().log(
            "kitp: change %s~%d could not link task %s: %s (%s)",
            project, number, r.taskId, r.message, r.code);
      }
    }
  }

  private static String commitMessage(ChangeInfo change) {
    if (change.revisions == null || change.currentRevision == null) {
      return "";
    }
    RevisionInfo rev = change.revisions.get(change.currentRevision);
    return rev == null || rev.commit == null || rev.commit.message == null ? "" : rev.commit.message;
  }
}

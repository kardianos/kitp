package kitp.gerrit;

import com.google.common.flogger.FluentLogger;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.annotations.PluginName;
import com.google.gerrit.server.config.GerritServerConfig;
import com.google.gerrit.server.config.PluginConfigFactory;
import com.google.gerrit.server.project.NoSuchProjectException;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.eclipse.jgit.lib.Config;

/**
 * The plugin's settings, read once at plugin load (reload the plugin to pick
 * up edits).
 *
 * <pre>
 * # gerrit.config
 * [plugin "kitp"]
 *   url = https://kitp.example.com       # kitp base URL (required)
 *   commentlink = kitp                    # commentlink whose match finds task ids
 *   taskPattern = …                       # extra extraction-only regexes (repeatable)
 *   kind = gerrit                         # link kind sent to kitp
 *   reviewLabel = Code-Review             # label that drives reviewed / approved
 *   includePrivate = false                # link private changes too
 *   timeout = 10s
 *   retries = 3
 *
 * # secure.config
 * [plugin "kitp"]
 *   token = …                             # kitp user_token for the plugin's agent
 *
 * [commentlink "kitp"]                    # gerrit.config — linkifies AND extracts
 *   match = "\\b(?:[Tt]ask|[Kk]itp)(?::\\s*#?|\\s+#)(\\d+)\\b"
 *   link = https://kitp.example.com/task/$1
 * </pre>
 *
 * A project can opt out with {@code [plugin "kitp"] enabled = false} in its
 * project.config (inherited, so setting it on a parent covers its children).
 */
@Singleton
class KitpConfig {
  private static final FluentLogger log = FluentLogger.forEnclosingClass();

  private final String pluginName;
  private final PluginConfigFactory cfgFactory;

  final String url;
  final String token;
  /** The commentlink's match (or the default), then each plugin.kitp.taskPattern. */
  final List<Pattern> taskPatterns;
  final String kind;
  final String reviewLabel;
  final boolean includePrivate;
  final Duration timeout;
  final int retries;

  @Inject
  KitpConfig(
      @PluginName String pluginName,
      PluginConfigFactory cfgFactory,
      @GerritServerConfig Config serverConfig) {
    this.pluginName = pluginName;
    this.cfgFactory = cfgFactory;
    String section = "plugin";
    url = trimSlash(nullToEmpty(serverConfig.getString(section, pluginName, "url")));
    // GerritConfig falls back to secure.config, where the token belongs.
    token = nullToEmpty(serverConfig.getString(section, pluginName, "token")).trim();
    kind = orDefault(serverConfig.getString(section, pluginName, "kind"), "gerrit");
    reviewLabel = orDefault(serverConfig.getString(section, pluginName, "reviewLabel"), "Code-Review");
    includePrivate = serverConfig.getBoolean(section, pluginName, "includePrivate", false);
    timeout =
        Duration.ofSeconds(
            Math.max(1, serverConfig.getTimeUnit(section, pluginName, "timeout", 10, TimeUnit.SECONDS)));
    retries = Math.max(0, serverConfig.getInt(section, pluginName, "retries", 3));

    String linkName = orDefault(serverConfig.getString(section, pluginName, "commentlink"), pluginName);
    String match = serverConfig.getString("commentlink", linkName, "match");
    if (match == null || match.isBlank()) {
      log.atInfo().log(
          "kitp: no [commentlink \"%s\"] match configured; finding task ids with the default %s"
              + " (add the commentlink so Gerrit also links them in the UI)",
          linkName, TaskRefs.DEFAULT_PATTERN);
      match = TaskRefs.DEFAULT_PATTERN;
    }
    List<Pattern> patterns = new ArrayList<>();
    try {
      patterns.add(Pattern.compile(match));
    } catch (PatternSyntaxException e) {
      log.atSevere().withCause(e).log(
          "kitp: commentlink.%s.match is not a valid regex; using the default", linkName);
      patterns.add(Pattern.compile(TaskRefs.DEFAULT_PATTERN));
    }
    // Extraction-only patterns: forms that should link a change to a task
    // without being linkified across the Gerrit UI (Java regex syntax).
    for (String extra : serverConfig.getStringList(section, pluginName, "taskPattern")) {
      if (extra == null || extra.isBlank()) {
        continue;
      }
      try {
        patterns.add(Pattern.compile(extra));
      } catch (PatternSyntaxException e) {
        log.atSevere().withCause(e).log("kitp: skipping invalid plugin.%s.taskPattern %s", pluginName, extra);
      }
    }
    taskPatterns = List.copyOf(patterns);

    if (!isConfigured()) {
      log.atWarning().log(
          "kitp: plugin.%s.url and the secure.config token are required; links are disabled",
          pluginName);
    }
  }

  boolean isConfigured() {
    return !url.isEmpty() && !token.isEmpty();
  }

  /** False when the project (or a parent) sets {@code plugin.kitp.enabled = false}. */
  boolean enabledFor(Project.NameKey project) {
    try {
      return cfgFactory
          .getFromProjectConfigWithInheritance(project, pluginName)
          .getBoolean("enabled", true);
    } catch (NoSuchProjectException e) {
      return false;
    }
  }

  private static String nullToEmpty(String s) {
    return s == null ? "" : s;
  }

  private static String orDefault(String s, String def) {
    return s == null || s.isBlank() ? def : s.trim();
  }

  private static String trimSlash(String s) {
    String t = s.trim();
    while (t.endsWith("/")) {
      t = t.substring(0, t.length() - 1);
    }
    return t;
  }
}

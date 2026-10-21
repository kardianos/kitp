package kitp.gerrit;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds the kitp task numbers a commit message mentions, by regex.
 *
 * <p>The primary pattern is the same regex Gerrit's {@code [commentlink "kitp"]}
 * uses to linkify those mentions in the UI, so what a reviewer sees as a link
 * is exactly what the plugin links back. Extra extraction-only patterns
 * ({@code plugin.kitp.taskPattern}) cover forms that shouldn't be linkified
 * everywhere, such as a bare {@code #634} at the end of the subject line.
 *
 * <p>The task number is the first capture group that matched, so a pattern
 * may use alternation ({@code a(\d+)|b(\d+)}). A pattern without groups
 * contributes the digits of the whole match.
 */
final class TaskRefs {
  /**
   * Used when no commentlink is configured. Plain enough for both the
   * server (Java) and Gerrit's web UI (JavaScript), which both evaluate
   * commentlink regexes. Matches {@code Task: 123}, {@code task: #123},
   * {@code task #123} and {@code kitp #123}; a bare number after "task"
   * ({@code task 5 minutes}) needs a colon or a {@code #}.
   */
  static final String DEFAULT_PATTERN = "\\b(?:[Tt]ask|[Kk]itp)(?::\\s*#?|\\s+#)(\\d+)\\b";

  private TaskRefs() {}

  /** Distinct positive task ids, in pattern order then first-mention order. */
  static List<String> parse(List<Pattern> patterns, String message) {
    Set<String> ids = new LinkedHashSet<>();
    if (message == null || message.isEmpty()) {
      return new ArrayList<>(ids);
    }
    for (Pattern pattern : patterns) {
      Matcher m = pattern.matcher(message);
      while (m.find()) {
        String raw = firstGroup(m);
        if (raw == null) {
          continue;
        }
        String digits = raw.replaceAll("\\D", "").replaceFirst("^0+", "");
        // Positive and within int64; kitp ids are bigint card ids.
        if (!digits.isEmpty() && digits.length() <= 18) {
          ids.add(digits);
        }
      }
    }
    return new ArrayList<>(ids);
  }

  static List<String> parse(Pattern pattern, String message) {
    return parse(List.of(pattern), message);
  }

  private static String firstGroup(Matcher m) {
    if (m.groupCount() == 0) {
      return m.group();
    }
    for (int g = 1; g <= m.groupCount(); g++) {
      if (m.group(g) != null) {
        return m.group(g);
      }
    }
    return null;
  }
}

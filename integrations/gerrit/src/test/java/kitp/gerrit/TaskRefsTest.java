package kitp.gerrit;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class TaskRefsTest {
  private static final List<Pattern> DEFAULT = List.of(Pattern.compile(TaskRefs.DEFAULT_PATTERN));

  /** The extraction-only subject-suffix rule documented for "subject #634" repos. */
  private static final Pattern SUBJECT_SUFFIX =
      Pattern.compile("\\A[^\\n]*?\\s#(\\d+)[ \\t]*(?:\\r?\\n|\\z)");

  private static final List<Pattern> WITH_SUBJECT = List.of(DEFAULT.get(0), SUBJECT_SUFFIX);

  /** Footers every Gerrit change carries; their digits must never match. */
  private static final String FOOTERS =
      "\n\nChange-Id: I8de4dbb09b21d6a8a20f11c215268dff9f40bcb8\n"
          + "Reviewed-on: https://gerrit.example.com/c/example/+/13373\n"
          + "Reviewed-by: A Reviewer <reviewer@example.com>\n";

  static Stream<Arguments> cases() {
    return Stream.of(
        // --- shapes the default pattern (= the commentlink) recognises ---
        Arguments.of("no message", DEFAULT, null, List.of()),
        Arguments.of("no mention, only footers", DEFAULT, "report: include the identifier" + FOOTERS, List.of()),
        Arguments.of("Task: footer", DEFAULT, "server: fix x\n\nTask: 123" + FOOTERS, List.of("123")),
        Arguments.of("task: # lower case", DEFAULT, "fix\n\ntask: #42", List.of("42")),
        Arguments.of("task #N line", DEFAULT,
            "app/proc/imp: accept a quoted nickname #634\n\nBreak-fix. Read bare quotes as text.\n\ntask #634" + FOOTERS,
            List.of("634")),
        Arguments.of("kitp #N line", DEFAULT, "app/schema: add columns\n\nNothing reads them yet.\n\nkitp #505" + FOOTERS,
            List.of("505")),
        Arguments.of("(kitp #N) inline in prose", DEFAULT,
            "app/proc/study: add an export\n\nAdd a Study Reports export (kitp #498): a TSV per sample." + FOOTERS,
            List.of("498")),
        Arguments.of("several mentions, first-mention order", DEFAULT,
            "fix\n\ntask #9\nTask: 3\nkitp #9", List.of("9", "3")),
        Arguments.of("leading zeros stripped", DEFAULT, "Task: 007", List.of("7")),
        Arguments.of("zero is not a task", DEFAULT, "Task: 0", List.of()),
        Arguments.of("bare number after task needs : or #", DEFAULT, "the task 5 minutes away", List.of()),
        Arguments.of("word boundary", DEFAULT, "Subtask: 12 and mytask #4", List.of()),
        Arguments.of("subject #N alone is not the default", DEFAULT, "app/portal: drop a check #622" + FOOTERS, List.of()),
        Arguments.of("CI job and alter numbers ignored", DEFAULT, "CI job 364 failed; alter 1416 replaced", List.of()),
        Arguments.of("absurdly long number ignored", DEFAULT, "Task: 1234567890123456789012", List.of()),
        // --- the extraction-only subject-suffix rule ---
        Arguments.of("subject suffix", WITH_SUBJECT, "app/portal: drop a check #622" + FOOTERS, List.of("622")),
        Arguments.of("subject suffix + task line dedupe", WITH_SUBJECT,
            "app/proc/dispatch: show route time #595\n\ntask #595" + FOOTERS, List.of("595")),
        Arguments.of("subject suffix, subject-only message", WITH_SUBJECT, "app/portal: drop a check #622", List.of("622")),
        Arguments.of("subject suffix with trailing space", WITH_SUBJECT, "fix it #77  \n\nbody", List.of("77")),
        Arguments.of("# mid-subject is not a suffix", WITH_SUBJECT, "fix #77 handling in parser\n\nbody", List.of()),
        Arguments.of("# at end of a body line is not the subject", WITH_SUBJECT, "fix parser\n\nsee #77", List.of()),
        // --- custom patterns ---
        Arguments.of("custom pattern group 1", List.of(Pattern.compile("kitp-(\\d+)")),
            "see kitp-5 and kitp-6", List.of("5", "6")),
        Arguments.of("alternation takes the group that matched",
            List.of(Pattern.compile("TASK=(\\d+)|K(\\d+)")), "TASK=12 K34", List.of("12", "34")),
        Arguments.of("custom pattern without a group", List.of(Pattern.compile("K-\\d+")),
            "K-12 K-34", List.of("12", "34")));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  void parse(String label, List<Pattern> patterns, String message, List<String> want) {
    assertEquals(want, TaskRefs.parse(patterns, message));
  }
}

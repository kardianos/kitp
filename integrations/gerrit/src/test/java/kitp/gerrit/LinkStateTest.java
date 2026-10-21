package kitp.gerrit;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gerrit.extensions.client.ChangeStatus;
import com.google.gerrit.extensions.common.AccountInfo;
import com.google.gerrit.extensions.common.ApprovalInfo;
import com.google.gerrit.extensions.common.ChangeInfo;
import com.google.gerrit.extensions.common.LabelInfo;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class LinkStateTest {
  private static final AccountInfo REVIEWER = new AccountInfo(1000001);

  private static ChangeInfo change(ChangeStatus status, Consumer<LabelInfo> label) {
    ChangeInfo c = new ChangeInfo();
    c.status = status;
    if (label != null) {
      LabelInfo l = new LabelInfo();
      label.accept(l);
      c.labels = Map.of("Code-Review", l);
    }
    return c;
  }

  private static ApprovalInfo vote(int value) {
    ApprovalInfo a = new ApprovalInfo(1000001);
    a.value = value;
    return a;
  }

  static Stream<Arguments> cases() {
    return Stream.of(
        Arguments.of("new, no labels", change(ChangeStatus.NEW, null), "open"),
        Arguments.of("new, label with no votes", change(ChangeStatus.NEW, l -> {}), "open"),
        Arguments.of("new, only zero votes", change(ChangeStatus.NEW, l -> l.all = List.of(vote(0))), "open"),
        Arguments.of("+1", change(ChangeStatus.NEW, l -> l.recommended = REVIEWER), "reviewed"),
        Arguments.of("-1", change(ChangeStatus.NEW, l -> l.disliked = REVIEWER), "reviewed"),
        Arguments.of("-2", change(ChangeStatus.NEW, l -> l.rejected = REVIEWER), "reviewed"),
        Arguments.of("detailed non-zero vote", change(ChangeStatus.NEW, l -> l.all = List.of(vote(0), vote(1))), "reviewed"),
        Arguments.of("+2", change(ChangeStatus.NEW, l -> l.approved = REVIEWER), "approved"),
        Arguments.of("+2 beside a -1", change(ChangeStatus.NEW, l -> { l.approved = REVIEWER; l.disliked = REVIEWER; }), "approved"),
        Arguments.of("merged", change(ChangeStatus.MERGED, l -> l.approved = REVIEWER), "merged"),
        Arguments.of("abandoned", change(ChangeStatus.ABANDONED, l -> l.recommended = REVIEWER), "abandoned"));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  void of(String label, ChangeInfo change, String want) {
    assertEquals(want, LinkState.of(change, "Code-Review"));
  }

  @ParameterizedTest(name = "other review label: {0}")
  @MethodSource("cases")
  void otherLabelIgnoresCodeReview(String label, ChangeInfo change, String want) {
    String expected = want.equals("merged") || want.equals("abandoned") ? want : "open";
    assertEquals(expected, LinkState.of(change, "Verified"));
  }
}

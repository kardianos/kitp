package kitp.gerrit;

import com.google.gerrit.extensions.client.ChangeStatus;
import com.google.gerrit.extensions.common.ApprovalInfo;
import com.google.gerrit.extensions.common.ChangeInfo;
import com.google.gerrit.extensions.common.LabelInfo;

/**
 * The state a change's kitp link shows, derived from the change's CURRENT
 * status and votes (never from the single event that triggered the sync), so
 * every sync reports the truth and a re-delivered or out-of-order event can't
 * regress it.
 *
 * <ul>
 *   <li>{@code merged} / {@code abandoned} — the change is closed;
 *   <li>{@code approved} — the review label carries its maximum vote (e.g. Code-Review +2);
 *   <li>{@code reviewed} — someone has voted on the review label;
 *   <li>{@code open} — otherwise.
 * </ul>
 */
final class LinkState {
  static final String OPEN = "open";
  static final String REVIEWED = "reviewed";
  static final String APPROVED = "approved";
  static final String MERGED = "merged";
  static final String ABANDONED = "abandoned";

  private LinkState() {}

  static String of(ChangeInfo change, String reviewLabel) {
    if (change.status == ChangeStatus.MERGED) {
      return MERGED;
    }
    if (change.status == ChangeStatus.ABANDONED) {
      return ABANDONED;
    }
    LabelInfo label = change.labels == null ? null : change.labels.get(reviewLabel);
    if (label == null) {
      return OPEN;
    }
    if (label.approved != null) {
      return APPROVED;
    }
    if (label.rejected != null || label.recommended != null || label.disliked != null) {
      return REVIEWED;
    }
    if (label.all != null) {
      for (ApprovalInfo vote : label.all) {
        if (vote.value != null && vote.value != 0) {
          return REVIEWED;
        }
      }
    }
    return OPEN;
  }
}

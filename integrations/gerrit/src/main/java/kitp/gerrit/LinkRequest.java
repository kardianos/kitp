package kitp.gerrit;

import com.google.gson.annotations.SerializedName;
import java.util.List;

/**
 * Wire shapes of kitp's forge hook, {@code POST /api/v1/links}: ONE change URL
 * linked to every task its commit message mentions. kitp keys each link on
 * (task, url), so re-sending is idempotent — an unchanged state writes nothing
 * and a new state updates the one link.
 */
final class LinkRequest {
  @SerializedName("task_ids")
  final List<String> taskIds;

  final String url;
  final String title;
  final String kind;
  final String state;

  LinkRequest(List<String> taskIds, String url, String title, String kind, String state) {
    this.taskIds = taskIds;
    this.url = url;
    this.title = title;
    this.kind = kind;
    this.state = state;
  }

  /** The hook's response: one result per distinct task id, in request order. */
  static final class Response {
    List<Result> results;
  }

  static final class Result {
    @SerializedName("task_id")
    String taskId;

    boolean ok;

    @SerializedName("link_id")
    String linkId;

    boolean created;
    boolean changed;
    String code;
    String message;
  }
}

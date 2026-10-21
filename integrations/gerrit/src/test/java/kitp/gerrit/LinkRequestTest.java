package kitp.gerrit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The plugin speaks kitp's POST /api/v1/links shape exactly. */
class LinkRequestTest {
  @Test
  void requestUsesTheHookFieldNames() {
    String json =
        KitpClient.toJson(
            new LinkRequest(
                List.of("12", "34"), "https://g.test/c/p/+/42", "fix x", "gerrit", "merged"));
    JsonObject o = new Gson().fromJson(json, JsonObject.class);
    assertEquals(
        "{\"task_ids\":[\"12\",\"34\"],\"url\":\"https://g.test/c/p/+/42\",\"title\":\"fix x\","
            + "\"kind\":\"gerrit\",\"state\":\"merged\"}",
        o.toString());
  }

  @Test
  void responseDecodesPerTaskResults() {
    LinkRequest.Response r =
        new Gson()
            .fromJson(
                "{\"results\":[{\"task_id\":\"12\",\"ok\":true,\"link_id\":\"901\",\"created\":true,"
                    + "\"changed\":true},{\"task_id\":\"34\",\"ok\":false,\"created\":false,"
                    + "\"changed\":false,\"code\":\"task_not_found\",\"message\":\"no task\"}]}",
                LinkRequest.Response.class);
    assertEquals(2, r.results.size());
    assertTrue(r.results.get(0).ok);
    assertEquals("901", r.results.get(0).linkId);
    assertFalse(r.results.get(1).ok);
    assertEquals("task_not_found", r.results.get(1).code);
  }
}

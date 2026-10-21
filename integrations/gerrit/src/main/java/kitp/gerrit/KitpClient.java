package kitp.gerrit;

import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;

/** POSTs links to kitp's forge hook with the plugin's bearer token. */
@Singleton
class KitpClient {
  /** A non-2xx answer. {@link #retryable} marks transient ones (5xx / 429). */
  static final class HookException extends IOException {
    final int status;
    final boolean retryable;

    HookException(int status, String body) {
      super("kitp answered HTTP " + status + ": " + abbreviate(body));
      this.status = status;
      this.retryable = status >= 500 || status == 429;
    }
  }

  private static final Gson GSON = new Gson();

  private final KitpConfig cfg;
  private final HttpClient http;

  @Inject
  KitpClient(KitpConfig cfg) {
    this.cfg = cfg;
    this.http = HttpClient.newBuilder().connectTimeout(cfg.timeout).build();
  }

  LinkRequest.Response post(LinkRequest req) throws IOException, InterruptedException {
    HttpRequest httpReq =
        HttpRequest.newBuilder(URI.create(cfg.url + "/api/v1/links"))
            .timeout(cfg.timeout)
            .header("Authorization", "Bearer " + cfg.token)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(req), StandardCharsets.UTF_8))
            .build();
    HttpResponse<String> resp = http.send(httpReq, HttpResponse.BodyHandlers.ofString());
    if (resp.statusCode() / 100 != 2) {
      throw new HookException(resp.statusCode(), resp.body());
    }
    try {
      LinkRequest.Response out = GSON.fromJson(resp.body(), LinkRequest.Response.class);
      if (out == null || out.results == null) {
        throw new IOException("kitp answered without results: " + abbreviate(resp.body()));
      }
      return out;
    } catch (JsonParseException e) {
      throw new IOException("kitp answered unreadable JSON: " + abbreviate(resp.body()), e);
    }
  }

  static String toJson(LinkRequest req) {
    return GSON.toJson(req);
  }

  private static String abbreviate(String s) {
    if (s == null) {
      return "";
    }
    String t = s.strip();
    return t.length() <= 300 ? t : t.substring(0, 300) + "…";
  }
}

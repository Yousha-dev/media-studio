package main

import (
	"encoding/json"
	"testing"
)

func TestResourcesAreBoundedAndSecretFree(t *testing.T) {
	for _, path := range []string{"studio", "studio.css", "app.mjs", "models.mjs", "realtime.mjs", "catalog.json"} {
		r := serveResource(managementRequest{"GET", resourceBase + path})
		if r.StatusCode != 200 || len(r.Body) == 0 || r.Headers.Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid resource %s: %d", path, r.StatusCode)
		}
	}
	for _, path := range []string{"../secrets.json", "../../config.yaml", "studio/", "", "unknown.js"} {
		if r := serveResource(managementRequest{"GET", resourceBase + path}); r.StatusCode != 404 {
			t.Fatalf("unexpected exposed path %s", path)
		}
	}
	if r := serveResource(managementRequest{"POST", resourceBase + "studio"}); r.StatusCode != 405 {
		t.Fatal("resource accepts mutations")
	}
}

func TestRegistrationAndCatalog(t *testing.T) {
	registration, err := dispatch("plugin.register", nil)
	if err != nil {
		t.Fatal(err)
	}
	metadata := registration.(map[string]any)["metadata"].(map[string]any)
	for _, field := range []string{"Name", "Version", "Author", "GitHubRepository"} {
		if metadata[field] == nil || metadata[field] == "" {
			t.Fatalf("host-required metadata missing: %s", field)
		}
	}
	if metadata["GitHubRepository"] != "https://github.com/Yousha-dev/media-studio" || metadata["Author"] != "Yousha-dev" || metadata["Version"] != pluginVersion {
		t.Fatal("release metadata does not identify this plugin repository")
	}
	value, err := dispatch("management.register", nil)
	if err != nil {
		t.Fatal(err)
	}
	registered := value.(map[string]any)
	if len(registered["routes"].([]any)) != 0 {
		t.Fatal("plugin should not expose privileged actions")
	}
	var catalog []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	}
	raw, _ := assets.ReadFile("catalog.json")
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, model := range catalog {
		if model.ID == "" || seen[model.ID] {
			t.Fatalf("invalid catalog ID: %q", model.ID)
		}
		seen[model.ID] = true
		if model.Kind != "image" && model.Kind != "voice" && model.Kind != "video" {
			t.Fatalf("invalid category: %s", model.Kind)
		}
	}
	if !seen["gpt-live-1-codex"] || !seen["gpt-image-2"] || !seen["grok-imagine-video"] {
		t.Fatal("missing core media capability")
	}
}

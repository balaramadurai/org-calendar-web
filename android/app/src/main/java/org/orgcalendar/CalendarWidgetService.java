package org.orgcalendar;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Service that provides RemoteViews for the widget list.
 */
public class CalendarWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new CalendarWidgetFactory(getApplicationContext());
    }

    /**
     * Factory that creates the list items for the widget.
     */
    static class CalendarWidgetFactory implements RemoteViewsFactory {
        private Context context;
        private List<EventItem> events = new ArrayList<>();

        CalendarWidgetFactory(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {
            // Initial load
            loadEvents();
        }

        @Override
        public void onDataSetChanged() {
            // Refresh data
            loadEvents();
        }

        @Override
        public void onDestroy() {
            events.clear();
        }

        @Override
        public int getCount() {
            return events.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position >= events.size()) {
                return null;
            }

            EventItem event = events.get(position);
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_event_item);

            views.setTextViewText(R.id.event_title, event.title);
            views.setTextViewText(R.id.event_time, event.time != null ? formatTime(event.time) : "All day");

            // Set color indicator
            try {
                int color = Color.parseColor(event.color);
                views.setInt(R.id.event_color, "setBackgroundColor", color);
            } catch (Exception e) {
                views.setInt(R.id.event_color, "setBackgroundColor", Color.parseColor("#4dd0e1"));
            }

            // Show state badge if present
            if (event.state != null && !event.state.isEmpty()) {
                views.setTextViewText(R.id.event_state, event.state);
                views.setViewVisibility(R.id.event_state, android.view.View.VISIBLE);
                
                // Color based on state
                int stateColor = getStateColor(event.state);
                views.setInt(R.id.event_state, "setBackgroundColor", stateColor);
            } else {
                views.setViewVisibility(R.id.event_state, android.view.View.GONE);
            }

            // Set click intent
            Intent fillInIntent = new Intent();
            views.setOnClickFillInIntent(R.id.event_title, fillInIntent);

            return views;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null; // Use default loading view
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return false;
        }

        /**
         * Load events from the server API.
         */
        private void loadEvents() {
            events.clear();

            String serverUrl = CalendarWidget.getServerUrl(context);
            if (serverUrl == null || serverUrl.isEmpty()) {
                return;
            }

            // Get today's date
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            String today = sdf.format(new Date());

            try {
                URL url = new URL(serverUrl + "/events/" + today);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);

                if (conn.getResponseCode() == 200) {
                    BufferedReader reader = new BufferedReader(
                            new InputStreamReader(conn.getInputStream()));
                    StringBuilder response = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        response.append(line);
                    }
                    reader.close();

                    parseEvents(response.toString());
                }
                conn.disconnect();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        /**
         * Parse JSON response into event items.
         */
        private void parseEvents(String json) {
            try {
                JSONObject root = new JSONObject(json);
                JSONArray eventsArray = root.optJSONArray("events");
                
                if (eventsArray == null) {
                    // Try parsing as direct array
                    eventsArray = new JSONArray(json);
                }

                for (int i = 0; i < eventsArray.length(); i++) {
                    JSONObject eventJson = eventsArray.getJSONObject(i);
                    EventItem event = new EventItem();
                    event.title = eventJson.optString("title", "Untitled");
                    event.time = eventJson.optString("time", null);
                    event.state = eventJson.optString("state", null);
                    event.category = eventJson.optString("category", null);
                    event.color = getCategoryColor(event.category);
                    events.add(event);
                }

                // Sort by time
                java.util.Collections.sort(events, (a, b) -> {
                    if (a.time == null && b.time == null) return 0;
                    if (a.time == null) return 1;
                    if (b.time == null) return -1;
                    return a.time.compareTo(b.time);
                });

            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        /**
         * Format time string to 12-hour format.
         */
        private String formatTime(String time) {
            try {
                SimpleDateFormat input = new SimpleDateFormat("HH:mm", Locale.US);
                SimpleDateFormat output = new SimpleDateFormat("h:mm a", Locale.US);
                Date date = input.parse(time);
                return output.format(date);
            } catch (Exception e) {
                return time;
            }
        }

        /**
         * Get color for category.
         */
        private String getCategoryColor(String category) {
            if (category == null) return "#4dd0e1";
            
            // Simple hash-based color assignment
            String[] colors = {
                "#4dd0e1", "#ba68c8", "#ffb74d", "#81c784", "#f06292",
                "#64b5f6", "#e57373", "#fff176", "#4db6ac", "#9575cd"
            };
            int hash = Math.abs(category.hashCode());
            return colors[hash % colors.length];
        }

        /**
         * Get color for state badge.
         */
        private int getStateColor(String state) {
            if (state == null) return Color.GRAY;
            switch (state.toUpperCase()) {
                case "TODO":
                    return Color.parseColor("#64b5f6");
                case "NEXT":
                    return Color.parseColor("#ffb74d");
                case "DONE":
                    return Color.parseColor("#81c784");
                case "WAITING":
                    return Color.parseColor("#ba68c8");
                case "CANCELLED":
                    return Color.parseColor("#e57373");
                default:
                    return Color.GRAY;
            }
        }
    }

    /**
     * Simple event data class.
     */
    static class EventItem {
        String title;
        String time;
        String state;
        String category;
        String color;
    }
}

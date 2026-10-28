# Gradient

Gradient is an indoor cycling app for Android(upcomming). It talks to your smart trainer
and sensors over Bluetooth, sets the resistance for workouts and routes, and records your rides.

This repo is the web side of it: a few small tools that run in the browser and make the files the
app uses. They're plain HTML files with no build step and no backend.

## The tools

### Route builder (`index.html`)

Click on the map to drop waypoints, and the route follows the roads (BRouter does the routing, with
a few bike profiles to pick from) or goes in straight lines. You can also import a GPX you already
have. Elevation comes from Open-Meteo. Raw map elevation is noisy, so the builder smooths it and caps
the grade, so a 6% road doesn't come out as a jumble of 2% and 14% bits.

Then you export it:

- **CSV** for the Gradient app. You can bundle darkened map tiles of the area into the file, so the
  app's map page has something to show without internet access.
- **GPX** for pretty much anything else: Garmin Edge, Wahoo ELEMNT, Hammerhead Karoo, Bryton,
  or Strava / Komoot / RideWithGPS. It's a normal GPX 1.1 track with elevation, so you can plan a
  ride here and take it outside on your bike computer too.

It also estimates how long the route will take at a given steady power, using your weight, rolling
resistance and air drag. The little "i" buttons next to those fields explain what values to use.

### Workout builder (`workout-builder.html`)

Build structured workouts out of steps at a set power or heart rate: intervals, ladders, or one of
the templates. The trainer holds the power in ERG mode, so you don't shift. It exports a CSV for the app.

### Rides (`rides.html`)

Drop in the FIT files the app records and you get the numbers, graphs, time in zones, best efforts
and laps, plus a weekly history. The files are read in your browser and stay there.

### Privacy (`privacy.html`)

The privacy policy for the app and these tools.

## Running it

There's nothing to install. You can open the HTML files directly, or serve the folder:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. To put it online, any static hosting will do (GitHub Pages,
Netlify, etc.): just upload the files.

The only outside dependency is Leaflet, loaded from cdnjs.

## Your data

There are no accounts, analytics or cookies, and I don't run any servers. Everything you make is
saved in your browser's local storage. The workout builder and the Rides page don't send anything
anywhere. The route builder has to talk to a few public services to work: OpenStreetMap /
OpenTopoMap for the map, BRouter for routing, Open-Meteo for elevation and Nominatim for place
search. They get your waypoints and searches, nothing else. There's more detail in `privacy.html`.

## Credits

Map data © OpenStreetMap contributors. Thanks to the people behind BRouter, Open-Meteo, OpenTopoMap
and Leaflet, which do most of the hard work here.

## License

Copyright © 2026 r2b89. All rights reserved.

WAR FRONT — combined-arms 3D browser battle
==========================================

STEEL FRONT, SKY FRONT and SEA FRONT in one battle: two bases on the coast, each with
3 tanks, 3 jeeps with machine guns, 2 jets on the runway, 2 warships in its port and ПВО.
Same 6-digit rooms, lobby, sounds and Russian interface as the other fronts.

RUN
  npm install
  npm start
  -> open http://localhost:3000   (Railway: start command "npm start", reads PORT)

PLAY
  Create game -> share the 6-digit code / invite link -> pick a team -> host presses Start.
  Everyone starts in the commander view above their base (top-down, like Dota).
  Click one of your vehicles (on the map or in the list on the left) to get in.
  Scroll the mouse wheel out past the farthest camera (or press X) to rise back to the
  commander view and pick another vehicle. Each team has 30 reinforcement points; every
  Destroyed vehicles do not come back: the team that still has machines wins.

CONTROLS
  Commander view: WASD / right-drag to move the map, wheel = height, click the minimap to jump.
  Tank: WASD drive, mouse turns the turret, click fires (4 s reload), Shift zoom.
  Jeep: WASD drive (fast), hold click for the machine gun.
  Jet: starts parked on the runway. W/S throttle, A/D steer on the ground. Over 200 km/h
       move the mouse up to take off. In the air it follows the mouse. Click = cannon,
       keep an enemy ahead of the nose 1.5 s to lock, right-click / Q = homing rockets (8),
       Space = bomb (3), F = flares. Rearm: land at your base and stand still 30 s.
       Landing: flat ground (the runway), under ~290 km/h, wings level, gentle angle; S brakes.
       Leaving a jet in the air (X) means it crashes.
  Warship: W/S engine telegraph, A/D rudder, click = salvo from every turret that bears,
       right-click / Q = 6 guided rockets onto the aimed point (18 s reload).
  Tab scores · Enter chat · M mute · Esc pause

OTHER
  ПВО: 3 sites per base fire homing missiles at enemy jets within 1.5 km (flares decoy them).
  Vehicles repair slowly inside their own base (ships: in their port).
  Enemies show on the map/HUD only when one of your vehicles or ПВО sites spots them.

FILES
  server.js         rooms, lobby, vehicle ownership, hp, tickets, respawns
  public/index.html UI
  public/game.js    the whole client (Three.js served from node_modules)

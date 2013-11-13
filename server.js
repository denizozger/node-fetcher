var express = require('express');
var app = express();
var cronJob = require('cron').CronJob;
var http = require('http');

app.use(express.logger());

var port = process.env.PORT || 5000;

app.listen(port, function() {
  console.log('Server listening on %s', port);
});

var matchesAndVersions = {};
const defaultVersion = -1;

/**
 * Receive data fetch requests
 */
app.get('/fetchlist/new/:id', function(request, response) {
  var requestedMatchId = request.params.id;

  if(!requestedMatchId || requestedMatchId < 0) {
    console.warn('Bad Request: Invalid parameters')
    response.statusCode = 400;
    return response.send('Bad Request');
  }

  if (matchesAndVersions[requestedMatchId]) {
  	console.warn('This match information is in the fetchlist already. Match id: %s', requestedMatchId);
  	return response.send('This match information is in the fetchlist already');
  }

  matchesAndVersions[requestedMatchId] = defaultVersion;

  console.log('Successfully added match (id: %s) to the fetchlist. Current fetchlist:');
  console.log(JSON.stringify(matchesAndVersions, null, 4));

  response.send('Success');
});


var express = require('express');
var app = express();
var http = require('http');
var async = require('async');
var _ = require('underscore');
var request = require('request');

app.use(express.logger());

var port = process.env.PORT || 5000;

app.listen(port, function() {
  console.log('Server listening on %s', port);
});

var matchesAndVersions = {};
const defaultVersion = -1;
var allDataFetched = true;
// const dataRequestingNode = 'http://dry-wildwood-3323.herokuapp.com/broadcast/';
const dataRequestingNode = 'http://localhost:5000/broadcast/';

/**
 * The job that fetches data perioducally
 */
var fetchingJob = function () {
  if (allDataFetched) {
    allDataFetched = false;
    fetchData();
  } else {
    console.warn('[NOT READY] Data fetcher is still running, skipping this iteration');
  }
    setTimeout(fetchingJob, 5000);
}
fetchingJob();

/**
 * Receive data fetch requests
 */
app.get('/fetchlist/new/:id', function(request, response) {
  var requestedMatchId = request.params.id;

  if(!requestedMatchId || requestedMatchId < 0) {
    console.warn('Bad Request: Invalid parameters');
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

/**
 * Iterate through matches to watch, get new matches & match data, and broadcast new data if there are any
 */
function fetchData() {
  console.log('[BEGIN] Begin fetching data for %s matches', _.size(matchesAndVersions));

  var options = {
    host: 'nameless-retreat-3788.herokuapp.com',
    port: 80,
    method: 'GET'
  };

  // Asynchronously fetch match data
  async.forEach(_.keys(matchesAndVersions), function (matchId, callback) { 
    var updatedMatchInJSON;

    options.path = '/matchesfeed/' + matchId + '/matchcentre';

    var req = http.get(options, function(res) {
      var updatedMatchInJSON = '';
      res.setEncoding('utf8');

      // Append data as we receive it 
      res.on('data', function (chunk) {
        updatedMatchInJSON += chunk;
        console.log('Received some data from data source: %s', updatedMatchInJSON);
      });

      // When all data is received, check its version and broadcast it if received version is greater
      res.on('end', function(){
        var updatedMatch;
        try {
          updatedMatch = JSON.parse(updatedMatchInJSON);
        } catch (e) {
          console.error('Did not receive proper JSON object from data provider for match %s', matchId);
        }

        var existingVersion = matchesAndVersions[matchId];
        var newVersion;

        if (updatedMatch) {
          newVersion = updatedMatch['version'];
        }

        // Compare the existing and new versions
        if (updatedMatch && isNumber(existingVersion) && isNumber(newVersion)) {
          console.log('For match %s, current version is %s, new version is %s', matchId, existingVersion, newVersion);  

          if (newVersion > existingVersion) {
            broadcastNewMatchData(updatedMatch);
            matchesAndVersions[matchId] = newVersion; // update the version
          } else {
            console.log('No changes detected for match %s', matchId)
          }
        } else {
          console.error('Could not receive new match data or it was corrupt');
        }

        console.log('All data for match %s has been received', matchId);
        callback();
      });

      res.on('error', function(e) {
      console.error('Can not fetch match data: %s', e.message);
    });
    });
  }, function(err) {
    if (err) {
      console.error('Cant fetch match data: %s', err);  
    } 
      
    allDataFetched = true; 
    console.log('[COMPLETE] Data fetch is complete');
  }); 
}

// Send new match data to websocket client - or any other server
function broadcastNewMatchData(updatedMatch) {
  if (updatedMatch && _.isObject(updatedMatch)) {
    var matchId = updatedMatch['id'];

    console.log('Broadcasting new match data for match %s', matchId);

    request({
        uri: dataRequestingNode + matchId,
        method: 'POST',
        form: {
          newMatchData: JSON.stringify(updatedMatch)
        }
      }, function(error, response, body) {
        if (!error && response.statusCode == 200) {
          console.log('Successfully broadcasted match (id: %s) request message to %s, the response is %s', 
            matchId, dataRequestingNode + matchId, body); 
        } else {
          console.error('Can not broadcast match request message to %s: %s', dataRequestingNode + matchId, error);
        }
      });
  } else {
    console.warn('Match data to broadcast is corrupt: %s', updatedMatch);
  }
}

function isNumber(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}
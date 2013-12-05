'use strict';

const express = require('express'),
  app = express(),
  http = require('http'),
  request = require('request'),
  zmq = require('zmq'),
  cluster = require('cluster'),
  log = require('npmlog');

app.use(express.logger('dev'));

var port = process.env.PORT || 4000;

const DEFAULT_MAX_AGE = 5;
const DATA_REQUESTING_SERVER_URL = process.env.DATA_REQUESTING_SERVER_URL || 'http://node-socketio.herokuapp.com/broadcast/';
const DATA_PROVIDER_HOST = process.env.DATA_PROVIDER_HOST || 'node-dataprovider.herokuapp.com';
const DATA_PROVIDER_PORT = process.env.DATA_PROVIDER_PORT || 80;
const AUTHORIZATION_HEADER_KEY = 'bm9kZS13ZWJzb2NrZXQ=';
const WEB_SOCKET_SERVER_AUTHORIZATION_HEADER_KEY = 'bm9kZS1mZXRjaGVy';
const LOGGING_LEVEL = process.env.LOGGING_LEVEL || 'verbose';
const RETRY_FETCHING = 'retry';
const RESOURCE_FETCHED = 'fetched';

log.level = LOGGING_LEVEL;

var socketErrorHandler = function (error) {
    if (error) {
      log.error(error);
      throw Error(error);
    }
};

var fetchJobs = {}; // key = resourceId, value = job details & resource data

/**
 * Master process
 */
if (cluster.isMaster) {

  app.listen(port, function() {
    log.info('Server ' + process.pid + ' listening on', port);
  });

  // Receive resource required messages from WebSocketServer
  const resourceRequiredSubscriber = zmq.socket('sub').connect('tcp://localhost:5432');
  resourceRequiredSubscriber.subscribe('');
  // Publish resource data to WebSocketServer
  const resourceUpdatedPublisher = zmq.socket('pub').bind('tcp://*:5433', socketErrorHandler);

  // Push resource fetch jobs to workers
  const resourceFetchJobPusher = zmq.socket('push').bind('ipc://resource-fetch-job-pusher.ipc', socketErrorHandler);
  // Pull the result of fetch jobs (ie. resource data)
  const resourceFetchJobResultPuller = zmq.socket('pull').bind('ipc://resource-fetch-job-result-puller.ipc', socketErrorHandler);


  resourceRequiredSubscriber.on('message', function (message) {
      handleResourceRequested(message);     
  });

  function handleResourceRequested(message) {
    var resourceId = JSON.parse(message).id;

    if (fetchJobs[resourceId]) {
      log.silly('This resource is in fetch queue already: ' + resourceId);
      return;
    }

    var fetchJob = {
      resource : {
        id: resourceId,
        data: null
      },
      timeToFetchAgain : Date.now()
    };

    fetchJobs[resourceId] = fetchJob;

    resourceFetchJobPusher.send(JSON.stringify(fetchJob));  

    log.silly('Pushed a fetch job for ' + fetchJob.id);
  }

  resourceFetchJobResultPuller.on('message', function (data) {
    var fetchJob = JSON.parse(data);

    log.silly('Master received new resource: ' + JSON.stringify(fetchJob));  

    if (fetchJob.result === RESOURCE_FETCHED) {
      publishResourceReceived(fetchJob);
    }

    if (fetchJob.timeToFetchAgain) { 
      resourceFetchJobPusher.send(JSON.stringify(fetchJob));
    } else {
      delete fetchJobs[fetchJob.resource.id];
    }
  });

  function publishResourceReceived(fetchJob) {
    log.silly('Master sending updated data of ' + fetchJob.resource.id + ' to web socket server.');

    resourceUpdatedPublisher.send(JSON.stringify(fetchJob.resource.data));
  }

  /**
   * Forking worker processes
   */
  const totalWorkerCount = 1;

  for (let i = 0; i < totalWorkerCount; i++) {
    cluster.fork();
  }

  // Histen for workers to come online
  cluster.on('online', function(worker) {
    log.info('Worker ' + worker.process.pid + ' is online.');
  });

  // Handle dead workers
  cluster.on('death', function(worker) {
    log.warn('Worker ' + worker.process.pid + ' died');
  });

  // Handle application termination
  process.on('SIGINT', function() {
    resourceRequiredSubscriber.close();
    resourceUpdatedPublisher.close();
    resourceFetchJobPusher.close();
    resourceFetchJobResultPuller.close();
    process.exit();
  });

} else {

  /**
   * Worker process
   */
  // Pull resource fetch jobs from the master 
  const resourceFetchJobPuller = zmq.socket('pull').connect('ipc://resource-fetch-job-pusher.ipc');
  // Push resource fetch result (ie. resource data) to master
  const resourceFetchJobResultPusher = zmq.socket('push').connect('ipc://resource-fetch-job-result-puller.ipc');

  // Receive fetch jobs from the master
  resourceFetchJobPuller.on('message', function (message) {
    var fetchJob = JSON.parse(message);

    log.silly('Worker ' + process.pid + ' received a fetch job for resource ' + fetchJob.resource.id);

    if (fetchJob.timeToFetchAgain <= Date.now()) { 
      fetchResource(fetchJob.resource.id);
    } else {
      fetchJob.result = RETRY_FETCHING;

      resourceFetchJobResultPusher.send(JSON.stringify(fetchJob));
    }
  });

  function fetchResource(resourceId) {
    var resourceURL = '/' + resourceId;

    var httpGetOptions = {
      host: DATA_PROVIDER_HOST,
      port: DATA_PROVIDER_PORT,
      method: 'GET',
      path: resourceURL
    };

    log.http('Worker ' + process.pid + ' requested resource ' + resourceId + ' from datafetcher ' + 
      DATA_PROVIDER_HOST + DATA_PROVIDER_PORT + resourceURL);

    http.get(httpGetOptions, function (response) {
      resourceReceived(resourceId, response);
    }); 
    
    return; 
  }

  function resourceReceived(resourceId, response) {
    var responseBody = '';
    response.setEncoding('utf8');

    response.on('data', function (chunk) {
      responseBody += chunk;
    });

    response.on('end', function() {

      log.http('Worker ' + process.pid + ' received new resource data for resource ' + 
        resourceId + ': ' + responseBody);

      var lastModified = getLastModifiedFromResponse(response);
      var maxAge = getMaxAgeFromResponse(response);

      fetchJobs[resourceId] = {
        resource : {
          id : resourceId,
          data : JSON.parse(responseBody)
        },
        result : RESOURCE_FETCHED,
        timeToFetchAgain : maxAge > 0 ? lastModified + maxAge : null
      };

      resourceFetchJobResultPusher.send(JSON.stringify(fetchJobs[resourceId]));      
    });
  }

  // Handle application termination
  process.on('SIGINT', function() {
    resourceFetchJobPuller.close();
    resourceFetchJobResultPusher.close();
    process.exit();
  });

}

function getLastModifiedFromResponse(response) {
  var lastModifiedHeader = response.headers['last-modified'];

  return lastModifiedHeader ? Date.parse(lastModifiedHeader) : 0;
}

function getMaxAgeFromResponse(response) {
  var cacheControlHeader = response.headers['cache-control'];
  var maxAge = getPropertyValueFromResponseHeader(cacheControlHeader, 'max-age');

  return (maxAge ? maxAge : DEFAULT_MAX_AGE) * 1000;
}

function getPropertyValueFromResponseHeader(responseHeaderValue, propertyName) {
  var indexOfProperty = responseHeaderValue.indexOf(propertyName);

  return responseHeaderValue.substring(propertyName.length + 1, responseHeaderValue.length + 1);
}

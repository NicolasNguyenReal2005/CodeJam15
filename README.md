# GoonTeam
CodeJam15 project


## How to run


### Preparation

A few things need to be set up first:

Make sure you have 3 API keys to different machine learning models.

To allow access to be used by the server, add them with

'$env:GROQ_API_KEY = "<value>"'
'$env:GEMINI_API_KEY = "<value>"'
'$env:OPEN_AI_KEY = "<value>"'

This will allow the server to function properly

### Server

First, turn on the server

NOTE: For this project, no server was deployed, as a result you'll need to run the server on your host
Make sure your server has all it's dependencies installed by:

Setting up your virtual environment
```
python -m venv .venv

. ./.venv/Scripts/activate

pip install -r requirements.txt

```

Finally, run this command

```
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

This will run your server where the analysis will be ran.

### Web Extension

Install the extension from !<LINK>

In  <Link> , access Developper mode and click Load Unpacked, select the folder with the extension, then enter.

If everything worked fine, the extension should be usable!

### Website

Access the index.html file from the repository, and use the "Try it out feature".

### Possible features

- Nobul will check the entire page content instead of requiring selection and user input.

-  Video will be analysed based off their audio.

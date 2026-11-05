import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {GourmetReel, calcTotalFrames} from '../engine/src/GourmetReel';
const Root = () => <Composition id="GourmetReel" component={GourmetReel}
  width={1080} height={1920} fps={30} durationInFrames={1}
  defaultProps={{fps: 30, cuts: []}}
  calculateMetadata={({props}) => ({fps: props.fps, durationInFrames: Math.max(1, calcTotalFrames(props))})} />;
registerRoot(Root);

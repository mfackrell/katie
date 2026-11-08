'use client';

import {useState} from 'react';

export default function Task4aPreviewProbePage(){
 const [changed,setChanged]=useState(false);
 return (
  <main id="task4a-app">
   <p id="task4a-state">{changed?'Changed state':'Initial state'}</p>
   <button id="task4a-change" type="button" onClick={()=>setChanged(true)}>
    Change state
   </button>
  </main>
 );
}
